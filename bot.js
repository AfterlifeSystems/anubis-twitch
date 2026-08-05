// bot.js
// Multi-channel Twitch chat bot, in the shape Nightbot uses: one bot account
// that sits in many channels at once, each of which opted in through
// web-server.js.
//
// Chat is read over EventSub WebSockets with the bot account's own user access
// token (`user:read:chat`), and replies are sent with `user:write:chat`. The
// token is renewed from its refresh token, so the process runs unattended
// without ever touching a Twitch login page.
//
// Every channel in the store is there because that channel's owner signed in
// and approved it. Leaving is immediate: a channel marked inactive has its
// subscription deleted on the next sync.

import { config as loadDotenv } from 'dotenv';
import WebSocket from 'ws';
import { deactivateChannel, readActiveChannels, setChannelAssistant } from './channel-store.js';
import {
	DEFAULT_IGNORED_CHATTER_LOGINS,
	formatChatReply,
	isBroadcasterOrModerator,
	parseChatMessage
} from './commands.js';
import { NeuralNexusClient } from './neural-nexus.js';
import { ChatRateLimiter, CommandCooldown } from './rate-limiter.js';
import { buildTokenRecord, getTokenStorePath, readTokenStore, writeTokenStore } from './token-store.js';
import { TWITCH_BOT_SCOPES, refreshAccessToken, validateAccessToken } from './twitch-oauth.js';

loadDotenv({ path: process.env.ENV_PATH || '.env', quiet: true });

const BOT_USER_ID = process.env.BOT_USER_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!';
const DEFAULT_ASSISTANT_ID = process.env.DEFAULT_ASSISTANT_ID || '';

// Comma-separated override, so a channel with an uncommon bot can add it.
const IGNORED_CHATTER_LOGINS = (process.env.IGNORED_CHATTER_LOGINS || '')
	.split(',')
	.map((login) => login.trim().toLowerCase())
	.filter(Boolean)
	.concat(DEFAULT_IGNORED_CHATTER_LOGINS);

const EVENTSUB_WEBSOCKET_URL =
	process.env.EVENTSUB_WEBSOCKET_URL || 'wss://eventsub.wss.twitch.tv/ws';

// Twitch allows 300 enabled subscriptions per WebSocket connection.
// https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 300;

const CHANNEL_SYNC_INTERVAL_MILLISECONDS = Number(process.env.CHANNEL_SYNC_INTERVAL_MS || 60_000);
const TOKEN_REFRESH_LEAD_MILLISECONDS = 5 * 60 * 1000;
const COMMAND_COOLDOWN_MILLISECONDS = Number(process.env.COMMAND_COOLDOWN_MS || 5_000);

let botLogin = process.env.BOT_LOGIN || '';
let tokenRecord;
let websocketClient;
let websocketSessionId;
let keepaliveTimeoutHandle;
let keepaliveTimeoutSeconds = 10;
let isShuttingDown = false;
let reconnectAttempt = 0;

// broadcaster_user_id -> EventSub subscription id
const subscriptionIdByChannel = new Map();

const chatRateLimiter = new ChatRateLimiter();
const commandCooldown = new CommandCooldown({ cooldownMilliseconds: COMMAND_COOLDOWN_MILLISECONDS });
const neuralNexusClient = new NeuralNexusClient();

(async () => {
	requireConfiguration();

	tokenRecord = await loadTokenRecord();
	await verifyBotIdentity();

	if (!neuralNexusClient.isConfigured) {
		console.warn(
			'NEURAL_NEXUS_API_URL / NEURAL_NEXUS_API_KEY are not set. The bot will echo ' +
				'prompts instead of calling an avatar.'
		);
	}

	connectToEventSub(EVENTSUB_WEBSOCKET_URL);
	setInterval(() => {
		syncChannelSubscriptions().catch((syncError) =>
			console.error(`Channel sync failed: ${syncError.message}`)
		);
	}, CHANNEL_SYNC_INTERVAL_MILLISECONDS);
})();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
	isShuttingDown = true;
	console.log('Shutting down.');
	if (websocketClient) {
		websocketClient.close();
	}
	process.exit(0);
}

function requireConfiguration() {
	const missingVariables = Object.entries({ CLIENT_ID, CLIENT_SECRET, BOT_USER_ID })
		.filter(([, value]) => !value)
		.map(([name]) => name);

	if (missingVariables.length) {
		console.error(`Missing required .env variables: ${missingVariables.join(', ')}`);
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

async function loadTokenRecord() {
	const storedTokenRecord = await readTokenStore();

	if (!storedTokenRecord || !storedTokenRecord.refresh_token) {
		console.error(`No Twitch tokens found at ${getTokenStorePath()}.`);
		console.error(
			'Start the web server and authorize the bot account once at /authorize-bot:  ' +
				'docker compose -f docker-compose.web.yml up --build'
		);
		process.exit(1);
	}

	if (isAccessTokenExpiring(storedTokenRecord)) {
		return renewAccessToken(storedTokenRecord);
	}

	return storedTokenRecord;
}

function isAccessTokenExpiring(candidateTokenRecord) {
	if (!candidateTokenRecord.expires_at) {
		return true;
	}
	return Date.now() >= candidateTokenRecord.expires_at - TOKEN_REFRESH_LEAD_MILLISECONDS;
}

async function renewAccessToken(currentTokenRecord) {
	console.log('Access token expired or expiring, refreshing...');

	let tokenEndpointResponse;
	try {
		tokenEndpointResponse = await refreshAccessToken({
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
			refreshToken: currentTokenRecord.refresh_token
		});
	} catch (refreshError) {
		console.error(`Could not refresh the access token: ${refreshError.message}`);
		console.error(
			'The refresh token may have been revoked (password change, disconnected app, or a ' +
				'new client secret). Re-authorize the bot account at /authorize-bot.'
		);
		process.exit(1);
	}

	const renewedTokenRecord = buildTokenRecord(tokenEndpointResponse);
	await writeTokenStore(renewedTokenRecord);
	console.log('Access token refreshed.');
	return renewedTokenRecord;
}

async function getAccessToken() {
	if (isAccessTokenExpiring(tokenRecord)) {
		tokenRecord = await renewAccessToken(tokenRecord);
	}
	return tokenRecord.access_token;
}

async function verifyBotIdentity() {
	let validation = await validateAccessToken(await getAccessToken());

	if (!validation.valid) {
		console.error(`Token is not valid. /oauth2/validate returned ${validation.status}.`);
		tokenRecord = await renewAccessToken(tokenRecord);
		validation = await validateAccessToken(tokenRecord.access_token);
	}

	if (!validation.valid) {
		console.error('Token is still not valid after refreshing.');
		console.error(validation.body);
		process.exit(1);
	}

	const validatedToken = validation.body;
	botLogin = validatedToken.login;
	console.log(`Validated token for ${validatedToken.login} (${validatedToken.user_id}).`);

	if (String(validatedToken.user_id) !== String(BOT_USER_ID)) {
		console.error(
			`Stored token user_id (${validatedToken.user_id} / ${validatedToken.login}) does not ` +
				`match BOT_USER_ID (${BOT_USER_ID}).`
		);
		process.exit(1);
	}

	const missingScopes = TWITCH_BOT_SCOPES.filter(
		(scope) => !(validatedToken.scopes || []).includes(scope)
	);
	if (missingScopes.length) {
		console.error(`Stored token is missing required scopes: ${missingScopes.join(', ')}`);
		process.exit(1);
	}
}

// Single entry point for Helix, so every call carries a fresh token and one
// retry covers a token revoked mid-session.
async function callHelix(url, requestOptions = {}, isRetryAfterRefresh = false) {
	const accessToken = await getAccessToken();

	const response = await fetch(url, {
		...requestOptions,
		headers: {
			...(requestOptions.headers || {}),
			Authorization: 'Bearer ' + accessToken,
			'Client-Id': CLIENT_ID
		}
	});

	if (response.status === 401 && !isRetryAfterRefresh) {
		tokenRecord = await renewAccessToken(tokenRecord);
		return callHelix(url, requestOptions, true);
	}

	return response;
}

// ---------------------------------------------------------------------------
// EventSub WebSocket
// ---------------------------------------------------------------------------

function connectToEventSub(websocketUrl, { isReconnectHandoff = false } = {}) {
	const previousClient = websocketClient;
	const client = new WebSocket(websocketUrl);
	let hasWelcomed = false;

	client.on('open', () => {
		console.log(`WebSocket connection opened to ${websocketUrl}`);
	});

	client.on('message', async (rawData) => {
		resetKeepaliveTimer();

		let envelope;
		try {
			envelope = JSON.parse(rawData.toString());
		} catch (parseError) {
			console.error(`Could not parse EventSub message: ${parseError.message}`);
			return;
		}

		switch (envelope.metadata.message_type) {
			case 'session_welcome': {
				hasWelcomed = true;
				websocketClient = client;
				websocketSessionId = envelope.payload.session.id;
				keepaliveTimeoutSeconds = envelope.payload.session.keepalive_timeout_seconds || 10;
				reconnectAttempt = 0;
				resetKeepaliveTimer();

				// On a reconnect handoff Twitch carries the existing subscriptions
				// across, so only close the old socket and keep going.
				if (isReconnectHandoff && previousClient) {
					previousClient.removeAllListeners();
					previousClient.close();
					console.log('Reconnect handoff complete; subscriptions carried over.');
					return;
				}

				subscriptionIdByChannel.clear();
				await syncChannelSubscriptions();
				break;
			}

			case 'session_keepalive':
				break;

			case 'session_reconnect':
				console.log('Twitch asked us to reconnect.');
				connectToEventSub(envelope.payload.session.reconnect_url, { isReconnectHandoff: true });
				break;

			case 'revocation': {
				// Sent when a user in the condition revoked authorization, changed
				// their password, or no longer exists. Stop treating that channel
				// as joined rather than retrying into a wall.
				const revokedCondition = envelope.payload.subscription.condition || {};
				const revokedChannelId = revokedCondition.broadcaster_user_id;
				console.warn(
					`Subscription revoked for channel ${revokedChannelId}: ` +
						`${envelope.payload.subscription.status}`
				);
				if (revokedChannelId) {
					subscriptionIdByChannel.delete(String(revokedChannelId));
					await deactivateChannel(revokedChannelId);
				}
				break;
			}

			case 'notification':
				if (envelope.metadata.subscription_type === 'channel.chat.message') {
					handleChatMessage(envelope.payload.event).catch((handlerError) =>
						console.error(`Chat handler failed: ${handlerError.message}`)
					);
				}
				break;
		}
	});

	client.on('error', (websocketError) => console.error(`WebSocket error: ${websocketError.message}`));

	client.on('close', (closeCode) => {
		if (isShuttingDown || (isReconnectHandoff && !hasWelcomed)) {
			return;
		}
		if (client !== websocketClient) {
			return;
		}
		console.warn(`WebSocket closed (${closeCode}).`);
		scheduleReconnect();
	});

	return client;
}

// Twitch sends a keepalive whenever the connection is idle. Silence past that
// window means the connection is gone even if no close frame arrived.
function resetKeepaliveTimer() {
	clearTimeout(keepaliveTimeoutHandle);
	keepaliveTimeoutHandle = setTimeout(
		() => {
			if (isShuttingDown) {
				return;
			}
			console.warn('No keepalive within the expected window; reconnecting.');
			if (websocketClient) {
				websocketClient.removeAllListeners();
				websocketClient.close();
			}
			scheduleReconnect();
		},
		(keepaliveTimeoutSeconds + 5) * 1000
	);
}

function scheduleReconnect() {
	clearTimeout(keepaliveTimeoutHandle);
	websocketClient = undefined;
	websocketSessionId = undefined;
	reconnectAttempt += 1;

	const backoffMilliseconds = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5));
	console.log(`Reconnecting in ${backoffMilliseconds}ms (attempt ${reconnectAttempt}).`);
	setTimeout(() => connectToEventSub(EVENTSUB_WEBSOCKET_URL), backoffMilliseconds);
}

// ---------------------------------------------------------------------------
// Channel subscriptions
// ---------------------------------------------------------------------------

async function syncChannelSubscriptions() {
	if (!websocketSessionId) {
		return;
	}

	const activeChannels = await readActiveChannels();
	const activeChannelIds = new Set(activeChannels.map((channel) => String(channel.broadcaster_user_id)));

	// Leave channels that withdrew consent.
	for (const [channelId, subscriptionId] of [...subscriptionIdByChannel]) {
		if (!activeChannelIds.has(channelId)) {
			await deleteSubscription(channelId, subscriptionId);
		}
	}

	// Join channels that opted in.
	for (const channel of activeChannels) {
		const channelId = String(channel.broadcaster_user_id);
		if (subscriptionIdByChannel.has(channelId)) {
			continue;
		}

		if (subscriptionIdByChannel.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
			console.error(
				`Reached the ${MAX_SUBSCRIPTIONS_PER_CONNECTION}-subscription limit for one ` +
					`WebSocket connection. #${channel.broadcaster_login} was not joined. Shard ` +
					'across additional connections to grow past this.'
			);
			break;
		}

		await createChatSubscription(channel);
	}
}

async function createChatSubscription(channel) {
	const response = await callHelix('https://api.twitch.tv/helix/eventsub/subscriptions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			type: 'channel.chat.message',
			version: '1',
			condition: {
				broadcaster_user_id: String(channel.broadcaster_user_id),
				user_id: String(BOT_USER_ID)
			},
			transport: { method: 'websocket', session_id: websocketSessionId }
		})
	});

	if (response.status !== 202) {
		const errorBody = await response.json().catch(() => ({}));
		console.error(
			`Could not join #${channel.broadcaster_login} (${response.status}): ` +
				`${errorBody.message || JSON.stringify(errorBody)}`
		);
		return;
	}

	const responseBody = await response.json();
	subscriptionIdByChannel.set(String(channel.broadcaster_user_id), responseBody.data[0].id);
	console.log(`Joined #${channel.broadcaster_login} [${responseBody.data[0].id}]`);
}

async function deleteSubscription(channelId, subscriptionId) {
	const response = await callHelix(
		`https://api.twitch.tv/helix/eventsub/subscriptions?id=${encodeURIComponent(subscriptionId)}`,
		{ method: 'DELETE' }
	);

	// 404 means it is already gone, which is the state we wanted anyway.
	if (response.status === 204 || response.status === 404) {
		subscriptionIdByChannel.delete(channelId);
		console.log(`Left channel ${channelId}.`);
		return;
	}

	console.error(`Could not leave channel ${channelId}: ${response.status}`);
}

// ---------------------------------------------------------------------------
// Chat handling
// ---------------------------------------------------------------------------

async function handleChatMessage(chatMessageEvent) {
	const channelId = String(chatMessageEvent.broadcaster_user_id);
	const channelLogin = chatMessageEvent.broadcaster_user_login;
	const chatterDisplayName = chatMessageEvent.chatter_user_name || chatMessageEvent.chatter_user_login;

	const intent = parseChatMessage({
		messageText: chatMessageEvent.message.text,
		botUserId: BOT_USER_ID,
		botLogin,
		chatterUserId: chatMessageEvent.chatter_user_id,
		chatterLogin: chatMessageEvent.chatter_user_login,
		commandPrefix: COMMAND_PREFIX,
		ignoredChatterLogins: IGNORED_CHATTER_LOGINS
	});

	if (intent.type === 'none') {
		return;
	}

	if (!commandCooldown.isReady(channelId, intent.commandName)) {
		return;
	}
	commandCooldown.markUsed(channelId, intent.commandName);

	if (intent.type === 'help') {
		return sendChatMessage(
			channelId,
			`Ask me anything with ${COMMAND_PREFIX}ask <question> or @${botLogin} <question>.`
		);
	}

	if (intent.type === 'avatar') {
		if (!isBroadcasterOrModerator(chatMessageEvent)) {
			return;
		}
		if (!intent.assistantId) {
			return sendChatMessage(channelId, `Usage: ${COMMAND_PREFIX}avatar <assistant_id>`);
		}
		await setChannelAssistant(channelId, intent.assistantId);
		return sendChatMessage(channelId, `Avatar set to ${intent.assistantId}.`);
	}

	if (intent.type === 'leave') {
		if (!isBroadcasterOrModerator(chatMessageEvent)) {
			return;
		}
		await sendChatMessage(channelId, 'Leaving this channel. Thanks for having me!');
		await deactivateChannel(channelId);
		const subscriptionId = subscriptionIdByChannel.get(channelId);
		if (subscriptionId) {
			await deleteSubscription(channelId, subscriptionId);
		}
		return;
	}

	// intent.type === 'ask'
	const activeChannels = await readActiveChannels();
	const channelRecord = activeChannels.find(
		(candidate) => String(candidate.broadcaster_user_id) === channelId
	);
	const assistantId = (channelRecord && channelRecord.assistant_id) || DEFAULT_ASSISTANT_ID;

	if (!assistantId) {
		return sendChatMessage(
			channelId,
			`No avatar is set for this channel. A moderator can set one with ${COMMAND_PREFIX}avatar <assistant_id>.`
		);
	}

	const replyText = await neuralNexusClient.requestAvatarReply({
		assistantId,
		prompt: intent.prompt,
		chatterDisplayName,
		channelLogin
	});

	if (!replyText) {
		return;
	}

	await sendChatMessage(channelId, `@${chatterDisplayName} ${formatChatReply(replyText)}`);
}

async function sendChatMessage(channelId, chatMessage) {
	const reply = formatChatReply(chatMessage);
	if (!reply) {
		return;
	}

	const hasSendSlot = await chatRateLimiter.acquireSendSlot(channelId);
	if (!hasSendSlot) {
		console.warn(`Dropped a reply in channel ${channelId} to stay within chat rate limits.`);
		return;
	}

	const response = await callHelix('https://api.twitch.tv/helix/chat/messages', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			broadcaster_id: channelId,
			sender_id: String(BOT_USER_ID),
			message: reply
		})
	});

	if (response.status !== 200) {
		const errorBody = await response.json().catch(() => ({}));
		console.error(
			`Failed to send chat message to ${channelId} (${response.status}): ` +
				`${errorBody.message || JSON.stringify(errorBody)}`
		);
		return;
	}

	// Twitch accepts the request but can still drop the message, for example
	// when the channel is in followers-only mode or the bot is banned there.
	const responseBody = await response.json();
	const sendResult = responseBody.data && responseBody.data[0];
	if (sendResult && sendResult.is_sent === false) {
		console.warn(
			`Message to ${channelId} was not sent: ` +
				`${(sendResult.drop_reason && sendResult.drop_reason.message) || 'unknown reason'}`
		);
	}
}

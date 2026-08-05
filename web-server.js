// web-server.js
// The self-service front door, and the piece that makes a multi-channel bot
// legitimate: a broadcaster adds the bot to their own channel by signing in as
// themselves and approving it, exactly as they would with Nightbot.
//
// Three flows, all of them ordinary Authorization Code grants:
//
//   bot      one-time. The bot account authorizes itself. Tokens are stored and
//            refreshed, so this is needed once, not once per session.
//   channel  a broadcaster proves they own the channel and consents to the bot
//            joining it.
//   leave    the same broadcaster withdraws that consent.
//
// Twitch requires the redirect URI to match the registered value exactly, so a
// single route serves both the pages and the callback, and the flow is carried
// in the OAuth `state` parameter.
//
// Data minimization: the channel and leave flows need proof of identity and
// consent, nothing more. The broadcaster's access and refresh tokens are used
// to read their own identity and are then discarded. Only the bot account's
// tokens are ever persisted.

import { config as loadDotenv } from 'dotenv';
import express from 'express';
import { addChannel, deactivateChannel, readActiveChannels } from './channel-store.js';
import { buildTokenRecord, writeTokenStore } from './token-store.js';
import {
	TWITCH_BOT_SCOPES,
	TWITCH_BROADCASTER_SCOPES,
	buildAuthorizeURL,
	createAuthorizationState,
	exchangeAuthorizationCodeForTokens,
	validateAccessToken
} from './twitch-oauth.js';

loadDotenv({ path: process.env.ENV_PATH || '.env', quiet: true });

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || 'http://localhost:9070';
const PORT = Number(process.env.OAUTH_PORT || 9070);
const BOT_USER_ID = process.env.BOT_USER_ID;
const BOT_LOGIN = process.env.BOT_LOGIN || 'the bot';
const DEFAULT_ASSISTANT_ID = process.env.DEFAULT_ASSISTANT_ID || '';

const PENDING_AUTHORIZATION_TTL_MILLISECONDS = 10 * 60 * 1000;

if (!CLIENT_ID || !CLIENT_SECRET) {
	console.error(
		'CLIENT_ID and CLIENT_SECRET are both required in .env. Generate a secret under ' +
			'"New Secret" on your application at https://dev.twitch.tv/console/apps.'
	);
	process.exit(1);
}

// state -> { flow, assistantId, createdAt }. Single-use and short-lived, so a
// redirect cannot be replayed and a code cannot be injected from elsewhere.
const pendingAuthorizations = new Map();

function createPendingAuthorization(flow, assistantId = '') {
	prunePendingAuthorizations();
	const state = createAuthorizationState();
	pendingAuthorizations.set(state, { flow, assistantId, createdAt: Date.now() });
	return state;
}

function consumePendingAuthorization(state) {
	prunePendingAuthorizations();
	const pending = pendingAuthorizations.get(state);
	if (pending) {
		pendingAuthorizations.delete(state);
	}
	return pending || null;
}

function prunePendingAuthorizations() {
	const now = Date.now();
	for (const [state, pending] of pendingAuthorizations) {
		if (now - pending.createdAt > PENDING_AUTHORIZATION_TTL_MILLISECONDS) {
			pendingAuthorizations.delete(state);
		}
	}
}

const app = express();

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function renderPage(heading, bodyHtml) {
	return `<!doctype html>
<html>
<head><title>${escapeHtml(heading)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  a.button { display: inline-block; background: #9146FF; color: #fff; padding: .6rem 1rem; border-radius: .4rem; text-decoration: none; }
  code { background: #eee; padding: .1rem .3rem; border-radius: .2rem; }
  ul { padding-left: 1.2rem; }
</style>
</head>
<body>
  <h1>${escapeHtml(heading)}</h1>
  ${bodyHtml}
</body>
</html>`;
}

// Landing page, and the OAuth callback, on the one registered redirect URI.
app.get('/', async (req, res) => {
	if (req.query.code || req.query.error) {
		return handleAuthorizationCallback(req, res);
	}

	const activeChannels = await readActiveChannels();
	const channelListHtml = activeChannels.length
		? `<ul>${activeChannels
				.map(
					(channel) =>
						`<li>#${escapeHtml(channel.broadcaster_login)}` +
						(channel.assistant_id ? ` — avatar <code>${escapeHtml(channel.assistant_id)}</code>` : '') +
						'</li>'
				)
				.join('')}</ul>`
		: '<p>No channels have added the bot yet.</p>';

	return res.send(
		renderPage(
			`Add ${BOT_LOGIN} to your channel`,
			`<p>Sign in with the Twitch account of the channel you want the bot in.
        You are approving it for <strong>your own channel only</strong>, and you can
        remove it at any time.</p>
      <p><a class="button" href="/join">Add to my channel</a></p>
      <p style="margin-top:2rem">After adding, run <code>/mod ${escapeHtml(BOT_LOGIN)}</code>
        in your chat. Moderator status raises the bot's rate limit from 20 to 100
        messages per 30 seconds.</p>
      <p>Chatters talk to the avatar with <code>!ask &lt;question&gt;</code> or
        <code>@${escapeHtml(BOT_LOGIN)} &lt;question&gt;</code>.</p>
      <h2>Channels</h2>
      ${channelListHtml}
      <p><a href="/leave">Remove the bot from my channel</a>
        &middot; <a href="/authorize-bot">Authorize the bot account</a> (operator only)</p>`
		)
	);
});

app.get('/authorize-bot', (req, res) => {
	const state = createPendingAuthorization('bot');
	return res.redirect(
		buildAuthorizeURL({
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			scopes: TWITCH_BOT_SCOPES,
			state,
			forceVerify: true
		})
	);
});

app.get('/join', (req, res) => {
	const state = createPendingAuthorization('channel', req.query.assistant_id || DEFAULT_ASSISTANT_ID);
	return res.redirect(
		buildAuthorizeURL({
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			scopes: TWITCH_BROADCASTER_SCOPES,
			state,
			forceVerify: true
		})
	);
});

app.get('/leave', (req, res) => {
	const state = createPendingAuthorization('leave');
	return res.redirect(
		buildAuthorizeURL({
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			scopes: TWITCH_BROADCASTER_SCOPES,
			state,
			forceVerify: true
		})
	);
});

async function handleAuthorizationCallback(req, res) {
	const authorizationCode = req.query.code;
	const state = req.query.state;
	const error = req.query.error;
	const errorDescription = req.query.error_description;

	if (error) {
		console.error(`Authorization was denied or failed: ${error} ${errorDescription || ''}`);
		return res
			.status(400)
			.send(
				renderPage(
					'Authorization failed',
					`<pre>${escapeHtml(error)} ${escapeHtml(errorDescription || '')}</pre>
           <p><a href="/">Back</a></p>`
				)
			);
	}

	const pending = consumePendingAuthorization(state);
	if (!pending) {
		console.error('Rejected an authorization code with an unknown or expired state.');
		return res
			.status(400)
			.send(
				renderPage(
					'Authorization failed',
					'<p>That link expired or did not originate here. <a href="/">Start again</a>.</p>'
				)
			);
	}

	try {
		const tokenEndpointResponse = await exchangeAuthorizationCodeForTokens({
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
			authorizationCode,
			redirectUri: REDIRECT_URI
		});

		const validation = await validateAccessToken(tokenEndpointResponse.access_token);
		if (!validation.valid) {
			throw new Error(`Access token failed validation: ${JSON.stringify(validation.body)}`);
		}

		if (pending.flow === 'bot') {
			return handleBotAuthorization(res, tokenEndpointResponse, validation.body);
		}

		if (pending.flow === 'leave') {
			return handleChannelLeave(res, validation.body);
		}

		return handleChannelJoin(res, validation.body, pending.assistantId);
	} catch (callbackError) {
		console.error(`Authorization callback failed: ${callbackError.message}`);
		return res
			.status(500)
			.send(
				renderPage('Authorization failed', `<pre>${escapeHtml(callbackError.message)}</pre>`)
			);
	}
}

async function handleBotAuthorization(res, tokenEndpointResponse, validatedToken) {
	const { login, user_id: userId } = validatedToken;

	if (BOT_USER_ID && String(userId) !== String(BOT_USER_ID)) {
		console.error(`Approved as ${login} (${userId}), which is not BOT_USER_ID (${BOT_USER_ID}).`);
		return res.status(400).send(
			renderPage(
				'Wrong account',
				`<p>Approved as <strong>${escapeHtml(login)}</strong> (${escapeHtml(userId)}), but
         BOT_USER_ID is ${escapeHtml(BOT_USER_ID)}. Sign in as the bot account and try again.</p>`
			)
		);
	}

	await writeTokenStore(buildTokenRecord(tokenEndpointResponse));
	console.log(`Stored access token and refresh token for the bot account ${login} (${userId}).`);

	return res.send(
		renderPage(
			'Bot authorized',
			`<p>Stored tokens for <strong>${escapeHtml(login)}</strong> (${escapeHtml(userId)}).
       The bot refreshes these itself from now on.</p>
       <p><a href="/">Back</a></p>`
		)
	);
}

async function handleChannelJoin(res, validatedToken, assistantId) {
	const { login, user_id: userId, scopes } = validatedToken;

	const channelRecord = await addChannel({
		broadcasterUserId: userId,
		broadcasterLogin: login,
		broadcasterDisplayName: login,
		assistantId,
		grantedScopes: scopes || []
	});

	console.log(`Channel #${login} (${userId}) added the bot.`);

	return res.send(
		renderPage(
			'Added to your channel',
			`<p>The bot will join <strong>#${escapeHtml(login)}</strong> within a minute.</p>
       <p>Run <code>/mod ${escapeHtml(BOT_LOGIN)}</code> in your chat to raise its rate limit.</p>
       <p>Chatters can now use <code>!ask &lt;question&gt;</code> or
         <code>@${escapeHtml(BOT_LOGIN)} &lt;question&gt;</code>.</p>
       ${
					channelRecord.assistant_id
						? `<p>Avatar: <code>${escapeHtml(channelRecord.assistant_id)}</code></p>`
						: '<p>No avatar is set yet. A moderator can set one with <code>!avatar &lt;assistant_id&gt;</code>.</p>'
				}
       <p>You can remove the bot at any time from <a href="/leave">this page</a>, or by
         revoking access under Twitch Settings &rarr; Connections.</p>`
		)
	);
}

async function handleChannelLeave(res, validatedToken) {
	const { login, user_id: userId } = validatedToken;
	const channelRecord = await deactivateChannel(userId);

	if (!channelRecord) {
		return res.send(
			renderPage(
				'Not in your channel',
				`<p>The bot is not in <strong>#${escapeHtml(login)}</strong>.</p>
         <p><a href="/">Back</a></p>`
			)
		);
	}

	console.log(`Channel #${login} (${userId}) removed the bot.`);

	return res.send(
		renderPage(
			'Removed from your channel',
			`<p>The bot has left <strong>#${escapeHtml(login)}</strong> and will stop reading
       that chat within a minute.</p>
       <p><a href="/">Back</a></p>`
		)
	);
}

app.listen(PORT, '0.0.0.0', () => {
	console.log(`\nWeb server listening on ${REDIRECT_URI} (port ${PORT})`);
	console.log(`Broadcasters add the bot at: ${REDIRECT_URI}/`);
	console.log(`Operator authorizes the bot account at: ${REDIRECT_URI}/authorize-bot\n`);
});

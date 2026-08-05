// channel-store.js
// The set of channels that have added the bot, in the Nightbot sense: a
// broadcaster opts their own channel in, and can opt back out at any time.
//
// A channel only ever appears here because that channel's owner signed in with
// Twitch and approved the join. The bot never joins a channel on its own
// initiative, and `leave` is always available to the owner.
//
// JSON file storage keeps this proof-of-concept dependency-free. Swap
// readChannels/writeChannels for a database when this outgrows one process.

import { constants as fileSystemConstants } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEFAULT_CHANNEL_STORE_PATH = '.twitch-tokens/channels.json';
const OWNER_READ_WRITE_ONLY = 0o600;

export function getChannelStorePath() {
	return resolve(process.env.CHANNEL_STORE_PATH || DEFAULT_CHANNEL_STORE_PATH);
}

export async function readChannels() {
	try {
		const fileContents = await readFile(getChannelStorePath(), 'utf8');
		const parsed = JSON.parse(fileContents);
		return Array.isArray(parsed.channels) ? parsed.channels : [];
	} catch (error) {
		if (error.code === 'ENOENT') {
			return [];
		}
		throw new Error(`Could not read channel store: ${error.message}`);
	}
}

async function writeChannels(channels) {
	const channelStorePath = getChannelStorePath();
	const temporaryPath = `${channelStorePath}.tmp`;

	await mkdir(dirname(channelStorePath), { recursive: true });
	await writeFile(temporaryPath, JSON.stringify({ channels }, null, 2) + '\n', {
		mode: OWNER_READ_WRITE_ONLY,
		flag: fileSystemConstants.O_WRONLY | fileSystemConstants.O_CREAT | fileSystemConstants.O_TRUNC
	});
	await rename(temporaryPath, channelStorePath);
}

export async function readActiveChannels() {
	return (await readChannels()).filter((channel) => channel.active);
}

export async function findChannel(broadcasterUserId) {
	return (
		(await readChannels()).find(
			(channel) => String(channel.broadcaster_user_id) === String(broadcasterUserId)
		) || null
	);
}

// Records a broadcaster's consent for the bot to operate in their channel.
export async function addChannel({
	broadcasterUserId,
	broadcasterLogin,
	broadcasterDisplayName,
	assistantId,
	grantedScopes
}) {
	const channels = await readChannels();
	const existingIndex = channels.findIndex(
		(channel) => String(channel.broadcaster_user_id) === String(broadcasterUserId)
	);

	const channelRecord = {
		broadcaster_user_id: String(broadcasterUserId),
		broadcaster_login: broadcasterLogin,
		broadcaster_display_name: broadcasterDisplayName,
		assistant_id: assistantId || null,
		granted_scopes: grantedScopes || [],
		active: true,
		joined_at: new Date().toISOString()
	};

	if (existingIndex >= 0) {
		// Preserve the avatar the channel already chose unless a new one was picked.
		channelRecord.assistant_id = assistantId || channels[existingIndex].assistant_id || null;
		channels[existingIndex] = { ...channels[existingIndex], ...channelRecord };
	} else {
		channels.push(channelRecord);
	}

	await writeChannels(channels);
	return channelRecord;
}

// Marks a channel inactive. The bot drops its subscription on the next sync.
export async function deactivateChannel(broadcasterUserId) {
	const channels = await readChannels();
	const channel = channels.find(
		(candidate) => String(candidate.broadcaster_user_id) === String(broadcasterUserId)
	);

	if (!channel) {
		return null;
	}

	channel.active = false;
	channel.left_at = new Date().toISOString();
	await writeChannels(channels);
	return channel;
}

export async function setChannelAssistant(broadcasterUserId, assistantId) {
	const channels = await readChannels();
	const channel = channels.find(
		(candidate) => String(candidate.broadcaster_user_id) === String(broadcasterUserId)
	);

	if (!channel) {
		return null;
	}

	channel.assistant_id = assistantId;
	await writeChannels(channels);
	return channel;
}

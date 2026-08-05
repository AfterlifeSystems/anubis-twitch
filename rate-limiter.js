// rate-limiter.js
// Keeps outgoing chat inside the limits Twitch publishes for a non-verified bot
// account: https://dev.twitch.tv/docs/chat/#rate-limits
//
//   20 messages per 30 seconds overall (100 where the bot holds moderator,
//   7500 for a verified bot — the conservative number is used because the bot
//   cannot reliably know its moderator status in every channel)
//   1 message per second per channel
//
// Exceeding these is what turns a bot into chat spam, so this is a compliance
// component and not only a politeness one. Replies that cannot be sent inside
// `maxWaitMilliseconds` are dropped rather than queued: a backlog that flushes
// later reads to both viewers and Twitch as flooding.

const GLOBAL_WINDOW_MILLISECONDS = 30_000;
const GLOBAL_MESSAGES_PER_WINDOW = 20;
const PER_CHANNEL_INTERVAL_MILLISECONDS = 1_000;

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ChatRateLimiter {
	constructor({
		globalMessagesPerWindow = GLOBAL_MESSAGES_PER_WINDOW,
		globalWindowMilliseconds = GLOBAL_WINDOW_MILLISECONDS,
		perChannelIntervalMilliseconds = PER_CHANNEL_INTERVAL_MILLISECONDS
	} = {}) {
		this.globalMessagesPerWindow = globalMessagesPerWindow;
		this.globalWindowMilliseconds = globalWindowMilliseconds;
		this.perChannelIntervalMilliseconds = perChannelIntervalMilliseconds;
		this.recentSendTimestamps = [];
		this.lastSendByChannel = new Map();
		this.droppedMessageCount = 0;
	}

	// Milliseconds the caller must wait before a send would be within limits,
	// or 0 when a send is allowed right now.
	millisecondsUntilAllowed(channelId, now = Date.now()) {
		this.recentSendTimestamps = this.recentSendTimestamps.filter(
			(timestamp) => now - timestamp < this.globalWindowMilliseconds
		);

		let waitMilliseconds = 0;

		if (this.recentSendTimestamps.length >= this.globalMessagesPerWindow) {
			const oldestTimestamp = this.recentSendTimestamps[0];
			waitMilliseconds = this.globalWindowMilliseconds - (now - oldestTimestamp);
		}

		const lastChannelSend = this.lastSendByChannel.get(String(channelId));
		if (lastChannelSend !== undefined) {
			const channelWait = this.perChannelIntervalMilliseconds - (now - lastChannelSend);
			waitMilliseconds = Math.max(waitMilliseconds, channelWait);
		}

		return Math.max(0, waitMilliseconds);
	}

	// Waits for a send slot. Returns false when the wait would exceed
	// `maxWaitMilliseconds`, meaning the caller should drop the message.
	async acquireSendSlot(channelId, { maxWaitMilliseconds = 3_000 } = {}) {
		const waitMilliseconds = this.millisecondsUntilAllowed(channelId);

		if (waitMilliseconds > maxWaitMilliseconds) {
			this.droppedMessageCount += 1;
			return false;
		}

		if (waitMilliseconds > 0) {
			await sleep(waitMilliseconds);
		}

		const now = Date.now();
		this.recentSendTimestamps.push(now);
		this.lastSendByChannel.set(String(channelId), now);
		return true;
	}
}

// Per-channel, per-command cooldown, the way Nightbot rate-limits an individual
// command so one chatter cannot repeat it back to back.
export class CommandCooldown {
	constructor({ cooldownMilliseconds = 5_000 } = {}) {
		this.cooldownMilliseconds = cooldownMilliseconds;
		this.lastUseByKey = new Map();
	}

	isReady(channelId, commandName, now = Date.now()) {
		const key = `${channelId}:${commandName}`;
		const lastUse = this.lastUseByKey.get(key);
		return lastUse === undefined || now - lastUse >= this.cooldownMilliseconds;
	}

	markUsed(channelId, commandName, now = Date.now()) {
		this.lastUseByKey.set(`${channelId}:${commandName}`, now);
	}
}

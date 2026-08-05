// commands.js
// Turns an incoming chat message into an intent, in the Nightbot style: an
// explicit `!command`, or a direct @mention of the bot.
//
// The bot only ever speaks when a chatter addressed it. It does not react to
// ambient conversation, which keeps it a requested participant in a channel
// rather than an uninvited one.

// Twitch rejects chat messages longer than 500 characters.
const TWITCH_MAX_MESSAGE_LENGTH = 500;

export const DEFAULT_COMMAND_PREFIX = '!';
export const ASK_COMMAND = 'ask';
export const HELP_COMMAND = 'help';
export const AVATAR_COMMAND = 'avatar';
export const LEAVE_COMMAND = 'leave';

// Other chat bots commonly present in Twitch channels. Two bots that answer
// each other produce an unbounded loop, which reads as flooding no matter how
// innocent the intent, so their messages are never treated as prompts.
export const DEFAULT_IGNORED_CHATTER_LOGINS = [
	'nightbot',
	'streamelements',
	'streamlabs',
	'moobot',
	'fossabot',
	'wizebot',
	'sery_bot'
];

export function parseChatMessage({
	messageText,
	botUserId,
	botLogin,
	chatterUserId,
	chatterLogin,
	commandPrefix = DEFAULT_COMMAND_PREFIX,
	ignoredChatterLogins = DEFAULT_IGNORED_CHATTER_LOGINS
}) {
	// Never react to our own messages. Without this a reply that happens to
	// contain the trigger would feed itself forever.
	if (String(chatterUserId) === String(botUserId)) {
		return { type: 'none', reason: 'self' };
	}

	if (chatterLogin && ignoredChatterLogins.includes(String(chatterLogin).toLowerCase())) {
		return { type: 'none', reason: 'ignored-bot' };
	}

	const trimmedMessage = (messageText || '').trim();
	if (!trimmedMessage) {
		return { type: 'none', reason: 'empty' };
	}

	// @botname <question>
	const mentionPattern = new RegExp(`^@${escapeRegExp(botLogin)}\\b[,:]?\\s*`, 'i');
	if (mentionPattern.test(trimmedMessage)) {
		const prompt = trimmedMessage.replace(mentionPattern, '').trim();
		return prompt
			? { type: 'ask', commandName: ASK_COMMAND, prompt }
			: { type: 'help', commandName: HELP_COMMAND };
	}

	if (!trimmedMessage.startsWith(commandPrefix)) {
		return { type: 'none', reason: 'not-addressed' };
	}

	const withoutPrefix = trimmedMessage.slice(commandPrefix.length);
	const firstSpaceIndex = withoutPrefix.indexOf(' ');
	const commandName = (
		firstSpaceIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, firstSpaceIndex)
	).toLowerCase();
	const commandArguments = firstSpaceIndex === -1 ? '' : withoutPrefix.slice(firstSpaceIndex + 1).trim();

	switch (commandName) {
		case ASK_COMMAND:
			return commandArguments
				? { type: 'ask', commandName: ASK_COMMAND, prompt: commandArguments }
				: { type: 'help', commandName: HELP_COMMAND };
		case HELP_COMMAND:
			return { type: 'help', commandName: HELP_COMMAND };
		case AVATAR_COMMAND:
			// Privileged: only the broadcaster or a moderator may switch avatars.
			return { type: 'avatar', commandName: AVATAR_COMMAND, assistantId: commandArguments };
		case LEAVE_COMMAND:
			// Privileged: lets a broadcaster remove the bot from chat directly.
			return { type: 'leave', commandName: LEAVE_COMMAND };
		default:
			return { type: 'none', reason: 'unknown-command' };
	}
}

// Twitch badges arrive on every chat message; they are the authoritative signal
// for who may run the privileged commands.
export function isBroadcasterOrModerator(chatMessageEvent) {
	const badges = chatMessageEvent.badges || [];
	return badges.some((badge) => badge.set_id === 'broadcaster' || badge.set_id === 'moderator');
}

// Shapes avatar output into something safe to put in a chat line.
export function formatChatReply(replyText, { maxLength = TWITCH_MAX_MESSAGE_LENGTH } = {}) {
	let reply = String(replyText || '').replace(/\s+/g, ' ').trim();

	// A reply beginning with / or . could read as a chat command. The Helix
	// send-message endpoint posts literal text rather than running commands,
	// but a moderator bot should not be one API change away from issuing
	// moderation actions it never intended.
	reply = reply.replace(/^[/.]+/, '');

	if (reply.length > maxLength) {
		reply = reply.slice(0, maxLength - 1).trimEnd() + '…';
	}

	return reply;
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

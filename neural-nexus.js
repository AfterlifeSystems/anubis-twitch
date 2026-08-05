// neural-nexus.js
// Client for the Neural Nexus avatar API.
//
// Contract taken from the published OpenAPI document (api-1.json):
//   POST {base}/message/{assistant_id}
//   header      API-KEY: <key>
//   body        multipart/form-data
//   fields      message, your_name, conversation_title, thread_id, stream, ...
//   response    200 application/json
//
// `stream` is set to false here. Twitch chat is a single finished line, so
// there is nothing for token streaming to do, and a non-streamed call is one
// request to reason about under a timeout.

const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 20_000;

export class NeuralNexusClient {
	constructor({
		baseUrl = process.env.NEURAL_NEXUS_API_URL,
		apiKey = process.env.NEURAL_NEXUS_API_KEY,
		requestTimeoutMilliseconds = Number(
			process.env.NEURAL_NEXUS_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MILLISECONDS
		)
	} = {}) {
		this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, '') : null;
		this.apiKey = apiKey;
		this.requestTimeoutMilliseconds = requestTimeoutMilliseconds;

		// One conversation thread per chatter per channel, so an avatar follows
		// a given viewer's line of conversation without mixing in other viewers.
		this.threadIdByConversationKey = new Map();
	}

	get isConfigured() {
		return Boolean(this.baseUrl && this.apiKey);
	}

	// Returns the avatar's reply text, or null when the avatar chose not to
	// answer or the call failed.
	async requestAvatarReply({ assistantId, prompt, chatterDisplayName, channelLogin }) {
		if (!this.isConfigured) {
			// Lets the Twitch side be exercised end to end before the avatar API
			// is wired up, instead of failing silently in chat.
			return `(no avatar configured) ${prompt}`;
		}

		if (!assistantId) {
			return null;
		}

		const conversationKey = `${channelLogin}:${chatterDisplayName}`;
		const requestBody = new FormData();
		requestBody.set('message', prompt);
		requestBody.set('your_name', chatterDisplayName);
		requestBody.set('conversation_title', `Twitch #${channelLogin}`);
		requestBody.set('stream', 'false');
		requestBody.set('include_quality_metrics', 'false');
		requestBody.set('include_usage_metrics', 'false');

		const existingThreadId = this.threadIdByConversationKey.get(conversationKey);
		if (existingThreadId) {
			requestBody.set('thread_id', existingThreadId);
		}

		const abortController = new AbortController();
		const timeoutHandle = setTimeout(
			() => abortController.abort(),
			this.requestTimeoutMilliseconds
		);

		try {
			const response = await fetch(
				`${this.baseUrl}/message/${encodeURIComponent(assistantId)}`,
				{
					method: 'POST',
					headers: { 'API-KEY': this.apiKey },
					body: requestBody,
					signal: abortController.signal
				}
			);

			if (!response.ok) {
				console.error(
					`Neural Nexus returned ${response.status} for assistant ${assistantId}: ` +
						`${(await response.text()).slice(0, 300)}`
				);
				return null;
			}

			const responseBody = await response.json();
			const threadId = responseBody.thread_id || responseBody.threadId;
			if (threadId) {
				this.threadIdByConversationKey.set(conversationKey, threadId);
			}

			return extractReplyText(responseBody);
		} catch (requestError) {
			if (requestError.name === 'AbortError') {
				console.error(
					`Neural Nexus timed out after ${this.requestTimeoutMilliseconds}ms ` +
						`for assistant ${assistantId}.`
				);
			} else {
				console.error(`Neural Nexus request failed: ${requestError.message}`);
			}
			return null;
		} finally {
			clearTimeout(timeoutHandle);
		}
	}
}

// The 200 response is typed as a bare object in the OpenAPI document, so the
// reply field is located by trying the shapes the API is known to return
// rather than assuming one.
export function extractReplyText(responseBody) {
	if (typeof responseBody === 'string') {
		return responseBody;
	}

	if (!responseBody || typeof responseBody !== 'object') {
		return null;
	}

	for (const candidateField of ['response', 'message', 'content', 'output', 'text', 'answer']) {
		const candidateValue = responseBody[candidateField];
		if (typeof candidateValue === 'string' && candidateValue.trim()) {
			return candidateValue;
		}
	}

	// LangGraph-shaped: the last assistant entry in a messages array.
	if (Array.isArray(responseBody.messages)) {
		for (let index = responseBody.messages.length - 1; index >= 0; index -= 1) {
			const messageEntry = responseBody.messages[index];
			const messageContent =
				typeof messageEntry === 'string' ? messageEntry : messageEntry && messageEntry.content;
			if (typeof messageContent === 'string' && messageContent.trim()) {
				return messageContent;
			}
		}
	}

	return null;
}

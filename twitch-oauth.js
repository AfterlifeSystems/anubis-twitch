// twitch-oauth.js
// Twitch OAuth endpoints and the Authorization Code grant flow.
//
// This module deliberately implements the Authorization Code grant rather than
// the Implicit grant. The Implicit grant (`response_type=token`) never issues a
// refresh token, so every token expiry required a human to re-approve the
// authorize URL in a browser. That limitation is what previously motivated
// automating a browser against the Twitch login pages, which is prohibited.
//
// The Authorization Code grant issues a refresh token alongside the access
// token, so the bot renews its own access token unattended through the
// documented token endpoint. No browser automation of any kind is needed.
//
// Reference:
//   https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow
//   https://dev.twitch.tv/docs/authentication/refresh-tokens/

import { randomBytes } from 'node:crypto';

export const TWITCH_AUTHORIZE_ENDPOINT = 'https://id.twitch.tv/oauth2/authorize';
export const TWITCH_TOKEN_ENDPOINT = 'https://id.twitch.tv/oauth2/token';
export const TWITCH_VALIDATE_ENDPOINT = 'https://id.twitch.tv/oauth2/validate';

// Granted once by the bot account itself. These let the bot read and write chat
// as itself: https://dev.twitch.tv/docs/chat/chatbot-guide/
export const TWITCH_BOT_SCOPES = ['user:bot', 'user:read:chat', 'user:write:chat'];

// Granted by each broadcaster who adds the bot to their channel. `channel:bot`
// is the broadcaster saying "this application may join my chat as a bot user".
//
// Reading chat with the bot's own user token does not strictly require this
// scope, because chat is public. It is requested anyway: it makes the
// broadcaster's consent explicit and revocable from their own Twitch
// connections page, which is the property that makes a multi-channel bot
// legitimate rather than presumptuous.
export const TWITCH_BROADCASTER_SCOPES = ['channel:bot'];

// Retained under the previous name so existing imports keep working.
export const TWITCH_CHAT_SCOPES = TWITCH_BOT_SCOPES;

// Random value echoed back on the redirect so the callback can reject any
// authorization code that did not originate from this server's own request.
export function createAuthorizationState() {
	return randomBytes(16).toString('hex');
}

export function buildAuthorizeURL({ clientId, redirectUri, scopes, state, forceVerify = false }) {
	const authorizeURL = new URL(TWITCH_AUTHORIZE_ENDPOINT);
	authorizeURL.searchParams.set('response_type', 'code');
	authorizeURL.searchParams.set('client_id', clientId);
	authorizeURL.searchParams.set('redirect_uri', redirectUri);
	authorizeURL.searchParams.set('scope', scopes.join(' '));
	authorizeURL.searchParams.set('state', state);

	// Makes Twitch show the approval screen even when the account already
	// approved, so a broadcaster signed in as the wrong account can see it.
	if (forceVerify) {
		authorizeURL.searchParams.set('force_verify', 'true');
	}

	return authorizeURL.toString();
}

async function requestTokens(requestBodyParameters) {
	const response = await fetch(TWITCH_TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(requestBodyParameters).toString()
	});

	const responseBody = await response.json();

	if (response.status !== 200) {
		throw new Error(
			`Twitch token endpoint returned status ${response.status}: ` +
				`${responseBody.message || JSON.stringify(responseBody)}`
		);
	}

	return responseBody;
}

// Step 2 of the Authorization Code grant: trade the single-use authorization
// code from the redirect for an access token and a refresh token. The client
// secret is sent from this server, never from the browser.
export async function exchangeAuthorizationCodeForTokens({
	clientId,
	clientSecret,
	authorizationCode,
	redirectUri
}) {
	return requestTokens({
		client_id: clientId,
		client_secret: clientSecret,
		code: authorizationCode,
		grant_type: 'authorization_code',
		redirect_uri: redirectUri
	});
}

// Renew an expired or expiring access token. Twitch rotates refresh tokens, so
// the caller must persist the refresh token returned here for the next renewal.
export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
	return requestTokens({
		client_id: clientId,
		client_secret: clientSecret,
		grant_type: 'refresh_token',
		refresh_token: refreshToken
	});
}

// Client Credentials grant. Produces an app access token that identifies this
// application only, with no user context. Used for public lookups such as
// resolving a login name to a numeric user id.
export async function requestAppAccessToken({ clientId, clientSecret }) {
	return requestTokens({
		client_id: clientId,
		client_secret: clientSecret,
		grant_type: 'client_credentials'
	});
}

// https://dev.twitch.tv/docs/authentication/validate-tokens/
export async function validateAccessToken(accessToken) {
	const response = await fetch(TWITCH_VALIDATE_ENDPOINT, {
		method: 'GET',
		headers: { Authorization: 'OAuth ' + accessToken }
	});

	if (response.status !== 200) {
		return { valid: false, status: response.status, body: await response.json() };
	}

	return { valid: true, status: response.status, body: await response.json() };
}

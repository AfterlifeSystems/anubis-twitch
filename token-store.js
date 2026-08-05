// token-store.js
// Persists the bot account's Twitch access token and refresh token to a file
// outside of version control, so the OAuth callback server and the bot process
// can share one credential set and the bot can rotate that credential set
// unattended.
//
// The file is written with owner-only permissions and is covered by .gitignore.

import { constants as fileSystemConstants } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEFAULT_TOKEN_STORE_PATH = '.twitch-tokens/tokens.json';
const OWNER_READ_WRITE_ONLY = 0o600;

export function getTokenStorePath() {
	return resolve(process.env.TOKEN_STORE_PATH || DEFAULT_TOKEN_STORE_PATH);
}

export async function readTokenStore() {
	const tokenStorePath = getTokenStorePath();

	try {
		return JSON.parse(await readFile(tokenStorePath, 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT') {
			return null;
		}
		throw new Error(`Could not read token store at ${tokenStorePath}: ${error.message}`);
	}
}

// Normalizes a Twitch token endpoint response into the stored shape and records
// an absolute expiry so the bot can refresh before the token actually lapses.
export function buildTokenRecord(tokenEndpointResponse) {
	const obtainedAtEpochMilliseconds = Date.now();

	return {
		access_token: tokenEndpointResponse.access_token,
		refresh_token: tokenEndpointResponse.refresh_token,
		scope: tokenEndpointResponse.scope || [],
		token_type: tokenEndpointResponse.token_type,
		obtained_at: obtainedAtEpochMilliseconds,
		expires_at: obtainedAtEpochMilliseconds + tokenEndpointResponse.expires_in * 1000
	};
}

export async function writeTokenStore(tokenRecord) {
	const tokenStorePath = getTokenStorePath();
	const temporaryPath = `${tokenStorePath}.tmp`;

	await mkdir(dirname(tokenStorePath), { recursive: true });
	await writeFile(temporaryPath, JSON.stringify(tokenRecord, null, 2) + '\n', {
		mode: OWNER_READ_WRITE_ONLY,
		flag: fileSystemConstants.O_WRONLY | fileSystemConstants.O_CREAT | fileSystemConstants.O_TRUNC
	});
	await rename(temporaryPath, tokenStorePath);
	await chmod(tokenStorePath, OWNER_READ_WRITE_ONLY);

	return tokenStorePath;
}

#!/usr/bin/env bash
# Resolve a Twitch login name to a numeric user id (for BOT_USER_ID / CHAT_CHANNEL_USER_ID).
#
# Uses only documented, supported Twitch endpoints, identifying this application
# by its own registered Client-Id:
#
#   1. POST https://id.twitch.tv/oauth2/token   (grant_type=client_credentials)
#      -> an app access token for this application
#      https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#client-credentials-grant-flow
#
#   2. GET  https://api.twitch.tv/helix/users?login=<login>
#      -> the numeric user id
#      https://dev.twitch.tv/docs/api/reference/#get-users
#
# Requires CLIENT_ID and CLIENT_SECRET in .env, from your own application at
# https://dev.twitch.tv/console/apps.
#
# Usage:
#   ./get-user-id.sh <login>
#   ./get-user-id.sh afterlife_systems_test

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Install it with: sudo apt-get install jq" >&2
  exit 1
fi

ENV_PATH="${ENV_PATH:-.env}"
if [[ -f "$ENV_PATH" ]]; then
  # shellcheck disable=SC1090
  set -a && source "$ENV_PATH" && set +a
fi

if [[ -z "${CLIENT_ID:-}" || -z "${CLIENT_SECRET:-}" ]]; then
  echo "CLIENT_ID and CLIENT_SECRET must be set in ${ENV_PATH}." >&2
  echo "Create an application and generate a secret at https://dev.twitch.tv/console/apps" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <twitch_login>" >&2
  exit 1
fi

LOGIN_LOWERCASE="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"

# Twitch logins are limited to letters, digits and underscores. Rejecting
# anything else keeps the value safe to place in a query string.
if [[ ! "$LOGIN_LOWERCASE" =~ ^[a-z0-9_]{1,25}$ ]]; then
  echo "'$1' is not a valid Twitch login name." >&2
  exit 1
fi

APP_ACCESS_TOKEN="$(curl -sS -X POST 'https://id.twitch.tv/oauth2/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "client_secret=${CLIENT_SECRET}" \
  --data-urlencode 'grant_type=client_credentials' \
  | jq -r '.access_token // empty')"

if [[ -z "$APP_ACCESS_TOKEN" ]]; then
  echo "Could not obtain an app access token. Check CLIENT_ID and CLIENT_SECRET." >&2
  exit 1
fi

RESPONSE_BODY="$(curl -sS --get 'https://api.twitch.tv/helix/users' \
  --data-urlencode "login=${LOGIN_LOWERCASE}" \
  -H "Authorization: Bearer ${APP_ACCESS_TOKEN}" \
  -H "Client-Id: ${CLIENT_ID}")"

USER_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.data[0].id // empty')"
RESOLVED_LOGIN="$(printf '%s' "$RESPONSE_BODY" | jq -r '.data[0].login // empty')"

if [[ -z "$USER_ID" ]]; then
  echo "No user found for login '${LOGIN_LOWERCASE}'." >&2
  printf '%s\n' "$RESPONSE_BODY" >&2
  exit 1
fi

echo "login=${RESOLVED_LOGIN}"
echo "user_id=${USER_ID}"
echo "CHAT_CHANNEL_USER_ID=${USER_ID}"
echo "BOT_USER_ID=${USER_ID}"

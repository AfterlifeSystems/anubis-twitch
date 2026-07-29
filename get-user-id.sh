#!/usr/bin/env bash
# Resolve a Twitch login name to a numeric user id (for BOT_USER_ID / CHAT_CHANNEL_USER_ID).
#
# Uses Twitch's public GQL endpoint — one curl, no OAuth / Client-ID from .env.
# Official Helix equivalent (needs matching Client-Id + Bearer):
#   curl -s 'https://api.twitch.tv/helix/users?login=<login>' \
#     -H "Authorization: Bearer <token>" -H "Client-Id: <client_id>"
#
# Usage:
#   ./get-user-id.sh
#   ./get-user-id.sh afterlife_systems_test
#   ./get-user-id.sh <login>

set -euo pipefail

LOGIN="${1:-afterlife_systems_test}"
LOGIN_LC="$(printf '%s' "$LOGIN" | tr '[:upper:]' '[:lower:]')"

# Public web Client-Id used by twitch.tv (no user OAuth required for login→id).
BODY="$(curl -sS 'https://gql.twitch.tv/gql' \
  -H 'Client-Id: kimne78kx3ncx6brgo4mv6wki5h1ko' \
  -H 'Content-Type: application/json' \
  --data "{\"query\":\"query{user(login:\\\"${LOGIN_LC}\\\"){id login displayName}}\"}")"

ID="$(printf '%s' "$BODY" | sed -n 's/.*"id":"\([0-9]*\)".*/\1/p' | head -n1)"
LOGIN_OUT="$(printf '%s' "$BODY" | sed -n 's/.*"login":"\([^"]*\)".*/\1/p' | head -n1)"

if [[ -z "$ID" ]]; then
  echo "No user found for login '${LOGIN}'." >&2
  echo "$BODY" >&2
  exit 1
fi

echo "login=${LOGIN_OUT}"
echo "user_id=${ID}"
echo "CHAT_CHANNEL_USER_ID=${ID}"
echo "BOT_USER_ID=${ID}"

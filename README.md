# anubis-twitch

Twitch chat bot integration for the Neural Nexus API, based on the
[Twitch Example Chatbot](https://dev.twitch.tv/docs/chat/chatbot-guide/#example-code).

By default the bot listens for `HeyGuys` and replies with `VoHiYo`.

## Two Compose files

| File | Service | Purpose |
|---|---|---|
| `docker-compose.oauth.yml` | oauth | Callback server on `:9070` — shows the access token |
| `docker-compose.bot.yml` | bot | Twitch chat bot (`bot.js`) |

You start them separately. Put `OAUTH_TOKEN` into `.env` yourself.

## Prerequisites

1. Twitch application at [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)
2. OAuth Redirect URL: `http://localhost:9070`
3. `CLIENT_ID`, `BOT_USER_ID`, `CHAT_CHANNEL_USER_ID` in `.env`

## Quick start

```bash

# 1) Build the Oauth Server:
docker compose -f docker-compose.oauth.yml up --build

# 2) Login with the BOT account (not the developer/streamer account)
# 3) Copy the oauth credential into the .env file

# 4) create credentials:
`cp .env.example .env`

# 5) ./get-user-id.sh streamer_name CHAT_CHANNEL_USER_ID
# 6) ./get-user-id.sh bot_name for BOT_USER_ID
# 7) CLIENT_ID is retrieved from the dev.twitch.tv portal for the created application
# 8) Start the Bot application:
`docker compose -f docker-compose.bot.yml up --build`
# 9) Open the chat for the streamer account and post `HeyGuys`. The bot will respond in the chat `VoHiYo`.


```

### 1. Start OAuth server

```bash
docker compose -f docker-compose.oauth.yml up --build
```

Open the authorize URL from the logs (signed in as the **bot** account),
approve, then copy `OAUTH_TOKEN=...` from the callback page into `.env`.

### 2. Start the bot

```bash
docker compose -f docker-compose.bot.yml up --build
```

Live test: send `HeyGuys` in chat → bot replies `VoHiYo`.

## Stop

```bash
docker compose -f docker-compose.oauth.yml down
docker compose -f docker-compose.bot.yml down
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `CLIENT_ID` | yes | Twitch application client id |
| `BOT_USER_ID` | yes | Bot account user id |
| `CHAT_CHANNEL_USER_ID` | yes | Channel user id |
| `OAUTH_TOKEN` | yes (for bot) | Paste manually from the oauth callback page |

## Local development

```bash
npm install
npm run oauth   # oauth-server.js
npm start       # bot.js
```

## Notes

- Implicit OAuth (`response_type=token`) — no client secret.
- Do not commit `.env`.

## Test Chat:
https://www.twitch.tv/afterlife_systems



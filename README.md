# anubis-twitch

Twitch chat bot for the Neural Nexus API, built on the
[Twitch Example Chatbot](https://dev.twitch.tv/docs/chat/chatbot-guide/#example-code).

It works the way Nightbot does: **one bot account** that sits in many channels
at once, where each broadcaster adds it to their own channel themselves and can
remove it at any time. Chatters talk to a Neural Nexus avatar with
`!ask <question>` or `@<botname> <question>`.

## How it works

```
broadcaster ──> web-server.js ──> channels.json ──> bot.js ──> Twitch EventSub
  "add to my        (Twitch          (who opted        (one WebSocket,
   channel"          OAuth)             in)             one sub per channel)
```

| Piece | Job |
|---|---|
| `web-server.js` | Bot authorization (once) and the broadcaster join/leave flow |
| `bot.js` | Holds the EventSub WebSocket, subscribes per channel, answers commands |
| `channel-store.js` | The list of channels that opted in |
| `token-store.js` | The bot account's access + refresh token |
| `rate-limiter.js` | Keeps sends inside Twitch's published chat limits |
| `neural-nexus.js` | Calls `POST /message/{assistant_id}` for the avatar's reply |
| `commands.js` | Parses `!ask` / `@mention`, formats replies for chat |

## Why one bot account and not one per avatar

Nightbot is a single Twitch account in millions of channels. Avatar selection
happens **per channel**, through `!avatar <assistant_id>`, not by registering a
new Twitch account per avatar.

Running a fleet of bot accounts would mean creating Twitch accounts
programmatically, which is an account-integrity violation and the fastest route
back to a suspension. One account, many channels, many avatars gets the same
product behavior with none of that risk.

## Authentication policy

This project authenticates **only** through documented Twitch endpoints, and
only ever as its own registered application:

- Tokens come from the
  [Authorization Code grant](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow),
  approved by a person in their own browser.
- Tokens are renewed with the documented
  [refresh token](https://dev.twitch.tv/docs/authentication/refresh-tokens/) endpoint.
- Lookups use the public [Helix API](https://dev.twitch.tv/docs/api/reference/)
  with this application's own `Client-Id`.
- A channel is only ever joined after its owner signed in as themselves and
  approved it, and leaving is available to them at any time.

The following are prohibited here and must never be reintroduced:

- Automating or driving a browser against `twitch.tv/login` or
  `passport.twitch.tv`, headless or otherwise.
- Injecting or reusing a Twitch session cookie (for example `auth-token`) in
  place of an interactive login.
- Sending a `Client-Id` belonging to anyone else, including the Twitch
  first-party web client, or calling undocumented endpoints such as
  `gql.twitch.tv`.
- Joining a channel that did not ask for the bot.
- Committing a browser profile, cookie store, or any other credential material.

### Privacy

The join and leave flows need proof of channel ownership and nothing else. The
broadcaster's tokens are used to read their own Twitch identity and are then
**discarded** — only the bot account's tokens are stored. Chat messages are
forwarded to the Neural Nexus API only when a chatter explicitly addressed the
bot; ambient chat is never sent anywhere.

### Rate limits

`rate-limiter.js` enforces the
[published limits](https://dev.twitch.tv/docs/chat/#rate-limits) for a
non-verified account: 20 messages per 30 seconds overall and 1 per second per
channel, plus a 5-second per-command cooldown. Replies that cannot be sent in
time are dropped rather than queued, so a backlog never flushes into chat as a
burst.

Moderator status in a channel raises the limit to 100 per 30 seconds, and
verified-bot status to 7500 — but **chatbot verification is currently paused**
by Twitch, so the conservative number is what the limiter uses.

## Setup

### Prerequisites

1. A Twitch application at [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)
2. OAuth Redirect URL set to `http://localhost:9070` (must match exactly)
3. A client secret generated on that application ("New Secret")
4. A separate Twitch account for the bot
5. `jq` installed, for `get-user-id.sh`

### 1. Configure

```bash
cp .env.example .env
# Fill in CLIENT_ID and CLIENT_SECRET.

./get-user-id.sh <bot_login>     # -> BOT_USER_ID
# Add BOT_USER_ID and BOT_LOGIN to .env, plus your Neural Nexus API settings.
```

### 2. Start the web server

```bash
docker compose -f docker-compose.web.yml up --build
```

### 3. Authorize the bot account (once)

Open <http://localhost:9070/authorize-bot> **signed in as the bot account** and
approve. The callback exchanges the code server-side and stores an access token
and a refresh token in `.twitch-tokens/tokens.json`. Nothing is pasted by hand.

The token's user must match `BOT_USER_ID`; the server refuses to store a token
for any other account.

### 4. Start the bot

```bash
docker compose -f docker-compose.bot.yml up --build
```

Access tokens last about four hours. The bot refreshes before expiry and again
on any `401`, persisting the rotated refresh token each time.

### 5. Add a channel

A broadcaster opens <http://localhost:9070/>, clicks **Add to my channel**, and
signs in with their own Twitch account. The bot joins within a minute
(`CHANNEL_SYNC_INTERVAL_MS`).

They should then run `/mod <botname>` in their chat for the higher rate limit.

## Chat commands

| Command | Who | Effect |
|---|---|---|
| `!ask <question>` | anyone | Avatar answers in chat |
| `@<botname> <question>` | anyone | Same as `!ask` |
| `!help` | anyone | Usage hint |
| `!avatar <assistant_id>` | broadcaster / mod | Set this channel's avatar |
| `!leave` | broadcaster / mod | Bot leaves the channel |

The bot only speaks when addressed, never reacts to its own messages, and
truncates replies to Twitch's 500-character limit.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `CLIENT_ID` | yes | Twitch application client id |
| `CLIENT_SECRET` | yes | Twitch application client secret (server-side only) |
| `BOT_USER_ID` | yes | Bot account numeric user id |
| `BOT_LOGIN` | yes | Bot account login, used to detect `@mentions` |
| `NEURAL_NEXUS_API_URL` | for replies | Neural Nexus API base URL |
| `NEURAL_NEXUS_API_KEY` | for replies | Sent as the `API-KEY` header |
| `DEFAULT_ASSISTANT_ID` | no | Avatar for channels that have not set one |
| `COMMAND_PREFIX` | no | Default `!` |
| `COMMAND_COOLDOWN_MS` | no | Default `5000` |
| `CHANNEL_SYNC_INTERVAL_MS` | no | Default `60000` |
| `TOKEN_STORE_PATH` | no | Default `.twitch-tokens/tokens.json` |
| `CHANNEL_STORE_PATH` | no | Default `.twitch-tokens/channels.json` |
| `OAUTH_REDIRECT_URI` | no | Default `http://localhost:9070` |
| `OAUTH_PORT` | no | Default `9070` |
| `EVENTSUB_WEBSOCKET_URL` | no | Default `wss://eventsub.wss.twitch.tv/ws` |

## Scaling limits

Twitch allows **300 enabled subscriptions per WebSocket connection** and 3
connections per client-id/user pair. One `bot.js` process therefore covers 300
channels; the bot logs an error and stops joining past that. Growing beyond it
means sharding channels across additional connections or processes.

## Local development

```bash
npm install
npm run web     # web-server.js
npm start       # bot.js
```

## Stop

```bash
docker compose -f docker-compose.web.yml down
docker compose -f docker-compose.bot.yml down
```

## Notes

- Authorization Code grant (`response_type=code`) — the only Twitch grant that
  issues refresh tokens.
- Do not commit `.env` or `.twitch-tokens/`.
- Rotate the client secret and re-authorize if either is ever exposed.

## Test Chat
https://www.twitch.tv/afterlife_systems

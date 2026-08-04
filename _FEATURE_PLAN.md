# Twitch ↔ Neural Nexus: @mention avatar bots

## Context

`anubis-twitch` is currently the stock Twitch EventSub sample: `bot.js` listens for the literal
string `HeyGuys` and replies `VoHiYo`. There is **zero** Neural Nexus wiring — no base URL, no API
key, no avatar id anywhere in the repo.

`_FEATURE.md` scopes the first slice to: **a Twitch chatter `@mention`s a bot, and the bot's bound
Neural Nexus avatar answers in chat.** Two future phases (feed the whole chat stream for
respond/notify/ignore; learned moderation) must not be blocked by the design.

Four decisions were made up front:

1. **One Node process**, a `bots.json` listing `{name, bot_user_id, oauth_token_env, assistant_id,
   channels[]}`, one EventSub WebSocket per bot. Several Twitch bot accounts, each bound to a
   distinct avatar, all under one Neural Nexus account/API key.
2. **One Neural Nexus thread per (bot, Twitch channel)** — the channel shares one conversation.
   Chatter display name rides in `your_name`.
3. Chat surface: `@bot <question>` plus `!help`, `!avatars`, `!new`, `!whoami`.
4. API at `https://api.neuralnexus.site`, key in `.env`.

### The finding that shapes this plan

**`/home/user/gh/anubis-project/anubis-discord` is a working, tested Neural Nexus client for this
exact API.** `api-1.json` declares an empty `{}` response schema for every custom endpoint, so the
wire format looked like a discovery problem — it is not. The discord repo has it solved and under
test:

- `src/nexus/sseStream.js` — `parseServerSentEvents`, documenting the verified frame shape from the
  server source (`anubis/src/api/webapp.py`, `message_graph_sse`):
  `usage_estimate` → `assistant_token` (`{text}`) → terminal `done` (`{content, thread_id,
  request_id}`) or `interrupt` (`{thread_id, interrupt}`), with `: keepalive` **comment** lines
  during post-reply sentiment analysis. Handles chunk boundaries splitting a JSON payload and a
  final frame with no trailing blank line.
- `src/nexus/client.js` — `NexusClient`: multipart construction (`buildMessageForm`), `NexusApiError`
  with `isAuthenticationFailure`, `describeErrorBody` for FastAPI's several error shapes.
- `src/discord/responder.js` — `chunkMessage`: paragraph → line → sentence → whitespace → hard cut.
- `src/discord/mentionHandler.js:158-167` — the `stream=false` shape: `{content, thread_id}`, with a
  tolerant fallback to a bare string.

**So: port, do not invent.** The discord repo is CommonJS; this repo is ESM (`"type": "module"`) —
the ports are converted, and kept structurally identical so a wire-format fix lands in both repos as
the same diff.

### Verified live against the API (read-only probes, this session)

| Call | Result |
|---|---|
| `GET /ok` | `200` |
| `GET /get_current_user_id` | bare JSON string `"6a6d09afdf3084272daa4103"` |
| `GET /list_user_avatars` | `[{assistant_id, graph_id:"Anubis", created_at, updated_at, config:{}, version, name:"Evan Woods", description:null, context:{}}]` |
| `GET /list_public_avatars` | same shape, no auth |
| `GET /conversations?assistant_id=…` | `[]` (array) |
| `GET /verify_subscription_status` | `{tier:"free", anonymous:false, pay_per_use_enabled:false, usage_period_end:…, meters:{messaging_tokens:{monthly_allotment:2000000, used_to_date:0, remaining:2000000, …}}}` |
| `GET /assistants/{id}` without key | `{"detail":"Please send API-KEY in request."}` — needs `API-KEY` despite the spec |

**`POST /message` was not probed** (plan mode is read-only). That is task 1 below — now a
*confirmation* of the discord repo's documented shape, not a discovery.

**The ownership gap is real and confirmed:** `is_personal_avatar_of_creator` is a write-only query
param on `POST /create_avatar` / `PATCH /modify_avatar`. It appears in **no** response schema, and
the live `list_user_avatars` response has no ownership field. See "Personal-avatar gate" below.

---

## Task 1 — Probe first (before any other code)

`scripts/probeNeuralNexusMessageStream.js`, stdout only, writes nothing.

Flags: `--assistant-id`, `--message`, `--no-stream`, `--thread-id`, `--raw`.
Streaming mode prints status, `content-type`, each decoded chunk as `JSON.stringify(text)` (so
`\n\n` boundaries are visible), then a summary: distinct `type` values, whether `done.content`
matches the concatenated `assistant_token` text, the `thread_id`, and time-to-first-token /
time-to-`done`.

Acceptance: frames match `anubis-discord/src/nexus/sseStream.js`. If they diverge, only
`serverSentEventStream.js` and the frame switch in `avatarConversation.js` change.

Also run it twice with `include_quality_metrics/include_usage_metrics` on and off — those drive the
sentiment pass that emits the keepalives. Nobody in Twitch chat sees metrics, so if they cost tail
latency, default them off.

---

## File layout

Convention (global CLAUDE.md): fully spelled-out identifiers, no acronyms, no truncations.
Stays ESM. **No new npm dependencies** — `ws` covers EventSub; global `fetch`/`FormData`/`Blob`
cover Neural Nexus; `dotenv`/`express` stay for the OAuth helper.

```
index.js                                  entrypoint: validate, start bots, signal handling
bots.example.json                         committed example (no secrets)
src/configuration.js                      .env + bots config load/validate/normalize
src/logger.js                             leveled logger, redacts credentials (port)

src/neuralNexus/serverSentEventStream.js  PORT of anubis-discord sseStream.js → ESM
src/neuralNexus/neuralNexusApiClient.js   PORT of anubis-discord client.js → ESM, trimmed
src/neuralNexus/neuralNexusApiError.js    + isUsageLimitReached (402)
src/neuralNexus/avatarConversation.js     one turn: stream → text, watchdogs, fallback, interrupt

src/twitch/twitchTokenValidator.js        /oauth2/validate + periodic revalidation
src/twitch/twitchHelixClient.js           createChatMessageSubscription, sendChatMessage
src/twitch/eventSubscriptionSocket.js     welcome/keepalive/reconnect/revocation/close + backoff
src/twitch/chatMessageChunker.js          reply → ≤500-code-point chat-safe strings
src/twitch/chatMessageSendQueue.js        per-channel serial send + token bucket + 429

src/bot/botRuntime.js                     wires ONE bot: socket + subscriptions + router
src/bot/botRuntimeRegistry.js             start/stop all bots, owns shared clients
src/bot/chatMessageRouter.js              loop prevention, dedupe, mention/command detection
src/bot/responsePolicy.js                 SEAM: respond | command | ignore | notify
src/bot/channelRequestQueue.js            serialize avatar calls per (bot, channel) + cooldowns
src/bot/conversationThreadStore.js        (bot, channel) → thread_id
src/bot/recentChatMessageBuffer.js        SEAM: bounded ring buffer (Phase 2 feedstock)
src/bot/ownerNotifier.js                  SEAM: notifyOwner(); logs today
src/bot/commands/{help,avatars,newConversation,whoAmI,commandRegistry}.js

scripts/probeNeuralNexusMessageStream.js
test/{serverSentEventStream,chatMessageChunker,chatMessageSendQueue,chatMessageRouter,configuration}.test.js
```

`bot.js` is **deleted**, its behavior absorbed into `src/twitch/*`. `npm test` → `node --test`
(matches anubis-discord). `oauth-server.js` / `oauth-url.js` stay.

---

## `bots.json`

Path from `BOTS_CONFIG_PATH` (default `./bots.json`), or inline via `BOTS_CONFIG_JSON`.
**Contains no secrets — only the *names* of environment variables.** Gitignored; commit
`bots.example.json`.

```json
{
  "commandPrefix": "!",
  "bots": [
    {
      "name": "anubis",
      "twitchBotUserIdentifier": "123456789",
      "twitchOauthTokenEnvironmentVariableName": "TWITCH_OAUTH_TOKEN_ANUBIS",
      "neuralNexusAssistantIdentifier": "47cfdaa2-1196-4519-9127-31cb13ff9d3a",
      "acknowledgedAsPersonalAvatar": true,
      "mentionAliases": ["anubis", "anubis_bot"],
      "channels": [
        { "twitchChannelUserIdentifier": "987654321",
          "twitchChannelLogin": "afterlife_systems",
          "botIsModerator": false,
          "respondsToBareCommands": true }
      ]
    }
  ],
  "ignoredChatterLogins": ["nightbot", "streamelements", "moobot", "fossabot", "streamlabs"]
}
```

- `mentionAliases` lowercased, matched as a leading `@alias` or bare `alias`; defaults to `[name]`.
- `respondsToBareCommands` prevents multi-bot flooding: when two bots share a channel, only that one
  answers a bare `!help`; others require `@botname !help`. Exactly one per channel — validated.
- **Backward compatible**: with no bots config present, synthesize a one-bot config from the existing
  `BOT_USER_ID` / `CHAT_CHANNEL_USER_ID` / `OAUTH_TOKEN` plus a new
  `NEURAL_NEXUS_ASSISTANT_IDENTIFIER`. Today's `.env` keeps working.

---

## The Neural Nexus request

Two rules that break the request if violated: **do not set `Content-Type`** (undici must generate
the multipart boundary), and **every scalar must be a string**.

```js
const requestForm = new FormData();
requestForm.set("message", promptText);
requestForm.set("stream", "true");
requestForm.set("your_name", chatterDisplayName);
requestForm.set("your_description", `a viewer in the Twitch chat of ${channelLogin}`);
requestForm.set("conversation_title", `Twitch #${channelLogin}`);
requestForm.set("include_quality_metrics", "false");
requestForm.set("include_usage_metrics", "false");
if (threadIdentifier) requestForm.set("thread_id", threadIdentifier);

await fetch(`${baseUrl}/message/${encodeURIComponent(assistantIdentifier)}`,
  { method: "POST", headers: { "API-KEY": apiKey }, body: requestForm, signal });
```

`your_description` is also the Phase 2 seam where an ambient chat summary goes.

**Consuming the stream.** Iterate `response.body` (async-iterable in Node 22) through the ported
`parseServerSentEvents`. `fetch` has no read timeout, so `avatarConversation.js` wraps the loop in
two watchdogs off one `AbortController`: an **idle watchdog** (45 s, reset on every decoded chunk
*including keepalive comments*) and a **total deadline** (120 s).

| frame | action |
|---|---|
| `usage_estimate` | log at debug |
| `assistant_token` | append `frame.text`; record time-to-first-token once |
| `done` | `content` is authoritative (replaces accumulated tokens); capture `thread_id` |
| `interrupt` | capture `thread_id`; take the interrupt path |
| `parse_error` | log at warn, keep reading |
| unknown | log at debug, keep reading |

`thread_id` is persisted **before** anything is sent to chat, so a crash mid-send cannot orphan the
channel's conversation.

**Fallback.** Stream fails *before* any `assistant_token` → retry once with `stream=false`
(180 s), reading `content`/`thread_id` off the JSON body, tolerating a bare string (the
`mentionHandler.js:158-167` pattern). Fails *after* tokens arrived → send what accumulated with
` … (cut off)`. `NEURAL_NEXUS_STREAMING_ENABLED=false` skips streaming entirely — Twitch cannot edit
messages, so streaming buys only stall detection and partial-reply salvage, but both are worth the
default `true`.

**Interrupt path.** Twitch chat is the wrong surface for identity-fact approval. Post one line
(`"@chatter my owner needs to approve a change before I can finish that."`), then immediately
`POST /message/{id}/resume` (form-urlencoded, `thread_id` + `decision=cancel`), consume and discard
its stream, log the payload, and `notifyOwner`. **A run left un-resumed would wedge the shared
channel thread** — that is the failure this prevents. `interruptDecision` is per-bot config,
default `cancel`.

---

## Errors: what chat actually sees

Every user-facing line is a constant in one module, and every one is suppressed by a
`(channel, reasonCategory)` rate limiter — the failure to avoid is a broken API turning ten
`@mentions` into ten identical error lines.

| Condition | Chat output | Behavior |
|---|---|---|
| 401 / 403 | "My Neural Nexus credentials were rejected. The operator has been notified." | once / 10 min / channel; `notifyOwner`; socket stays up |
| **402** (allotment gone, pay-per-use off) | "I've used up my monthly Neural Nexus allotment — no more replies until it resets." | once / hour; opens a **usage-limit gate** that short-circuits later calls with **zero** HTTP requests; clears at cached `usage_period_end` or after 15 min via `verify_subscription_status`. Undeclared in the spec — must be recognized by status code |
| 404 (avatar deleted) | "My avatar is no longer available." | once; degrade that bot only |
| 422 | "I couldn't send that to my avatar." | log `detail[]` via ported `describeErrorBody` |
| 429 from Neural Nexus | nothing on attempt 1 | 2 retries, jittered, honor `Retry-After` |
| 5xx / DNS / reset | "I couldn't reach my avatar just now — try again in a moment." | once / 60 s / channel |
| timeout, no text | "That one took too long. Try asking again." | |
| timeout, partial text | partial + " … (cut off)" | |
| `done` with empty content | "I don't have anything to add there." | |
| Helix 200 but `data[0].is_sent === false` | — | log `drop_reason` (AutoMod / follower-only / banned) and **abort the remaining chunks** — half a reply is worse than none; "My message was blocked in this channel." once / 10 min |
| Twitch token invalid | — | stop that bot's socket, log the exact re-authorization command, other bots keep running |

---

## Chunking (`chatMessageChunker.js`)

Adapt `chunkMessage` from `anubis-discord/src/discord/responder.js` (boundary accepted only past 66%
of the window). Twitch-specific changes:

1. `MAXIMUM_TWITCH_MESSAGE_LENGTH = 500`, target 460 to leave room for the `@chatter ` prefix.
   Measure with `[...text].length` (code points) so emoji cannot push a chunk over.
2. **Flatten newlines first** — Twitch chat has none. `\r?\n+` → `" — "`, collapse whitespace runs.
   Drop the code-fence balancing entirely; meaningless here.
3. **Neutralize a leading `/` or `.`** so a reply can never look like `/ban`. (Helix does not execute
   commands, but this costs nothing and removes the class.)
4. **Cap mention amplification** — rewrite every `@` in generated text except the deliberate
   `@chatter` prefix, so the avatar cannot ping people by hallucinating handles.
5. `MAXIMUM_REPLY_CHUNK_COUNT` default 3 (≈1400 chars); beyond it truncate at the last clean
   boundary and append `" … (truncated)"`.
6. First chunk prefixed `@${chatterLogin} `; continuations get `(2/3) ` so concurrent replies stay
   readable.

Tests: every chunk ≤500 code points; none starts with `/` or `.`; no newlines survive; 20 000 chars →
exactly `MAXIMUM_REPLY_CHUNK_COUNT` chunks with the marker; empty input → one empty chunk, never an
empty array (that would silently drop a reply).

## Send queue + request queue

`chatMessageSendQueue.js`, one instance per `(bot, channel)`:
strictly serial (a multi-chunk reply can never interleave); token bucket
`TWITCH_CHAT_MESSAGES_PER_SECOND` default `0.6` (non-mod: 20 per 30 s) or `2.5` when
`botIsModerator`, burst 3; **enqueue unit is a whole reply** (array of chunks); depth cap 5, overflow
drops the *newest*; **429 handling replaces the naive retry at `bot.js:120`** — read
`Ratelimit-Reset` / `Ratelimit-Remaining`, sleep to the reset instant +250 ms jitter, 3 attempts,
and feed `Ratelimit-Remaining` back into the bucket; shutdown drains with a 5 s grace.

`channelRequestQueue.js`, same key: **concurrency 1 per (bot, channel)** — with one shared thread per
channel, a second `/message` against a thread with a run in flight is exactly the conflict to avoid,
and serializing is the only defense the API offers. Global cap 4 concurrent Neural Nexus requests.
Per-chatter cooldown 20 s (dropped **silently** — a "you're on cooldown" reply is itself spam);
per-channel minimum gap 5 s; pending cap 2 (with 2–20 s latency, a deep queue answers questions from
four minutes ago). Every accepted request logs `{botName, channelLogin, chatterLogin,
queueWaitMilliseconds, timeToFirstTokenMilliseconds, totalMilliseconds, replyCharacterCount,
chunkCount}` — the data needed to tune cooldowns after the first live stream.

---

## EventSub robustness (`eventSubscriptionSocket.js`)

Fixes every gap in today's `bot.js:79-103`:

- **`session_welcome`** — store `session.id` and `keepalive_timeout_seconds`; arm a watchdog at
  `keepalive_timeout_seconds + 5`, reset on *any* frame; then one `channel.chat.message` v1
  subscription per channel.
- **`session_reconnect`** — open the new socket, **wait for its `session_welcome`**, swap, *then*
  close the old. **Do not re-subscribe** — Twitch carries subscriptions across a reconnect, and
  re-subscribing produces duplicate replies. No welcome in 30 s → discard and full reconnect.
- **`revocation`** — `user_removed`/`version_removed` → drop that channel; `authorization_revoked` →
  force token revalidation.
- **`close`/`error`** — full-jitter backoff 1 s → 60 s, fresh session + full re-subscribe.
  **Never `process.exit`** — today `bot.js:164` exits on a subscription failure, which would take
  down every other bot.
- **Dedupe** — bounded LRU of the last 1000 `metadata.message_id`; also drop notifications with
  `message_timestamp` older than 10 minutes (that is what a reconnect replay looks like).
- **Token revalidation** — re-hit `/oauth2/validate` every `min(3600, expires_in / 2)` seconds per
  bot, as Twitch requires.

**Loop prevention** in `chatMessageRouter.js`, in order: drop own id → drop **any configured bot's**
id (sibling avatars must not talk to each other forever) → drop `ignoredChatterLogins` → drop when
`source_broadcaster_user_id` differs from `broadcaster_user_id` (shared-chat traffic from another
channel) → only then match alias / command prefix. Messages dropped for *replying* purposes are
still pushed into `recentChatMessageBuffer` — dead weight today, the entire foundation of Phase 2.

---

## Startup validation (`index.js`), in order

1. **Configuration** — report *every* problem at once, not the first: missing env vars, duplicate bot
   names, duplicate `(bot, channel)` pairs, more than one `respondsToBareCommands` per channel,
   non-numeric user identifiers, missing `TWITCH_OAUTH_TOKEN_*`.
2. `GET /get_current_user_id` — non-empty string, else the API key is wrong; fail fast with that
   exact sentence.
3. `GET /verify_subscription_status` — log `tier`, `pay_per_use_enabled`,
   `meters.messaging_tokens.remaining`; if `remaining <= 0` and pay-per-use is off, warn loudly and
   pre-arm the usage-limit gate; cache `usage_period_end`.
4. `GET /list_user_avatars` — every bot's `neuralNexusAssistantIdentifier` must be present; missing →
   fail fast listing the available ids **and names** so the operator can paste the right one.
5. **Personal-avatar gate** (below).
6. **Per-bot Twitch token** — `/oauth2/validate`: `user_id` must equal `twitchBotUserIdentifier`;
   scopes must include `user:bot`, `user:read:chat`, `user:write:chat`. A failure disables *that
   bot*; only an all-bots failure exits 1.
7. Sockets, then per-channel subscriptions.
8. **Startup summary table** — bot → avatar name → assistant id (first 8) → channels → aliases. This
   is what an operator screenshots when something is misconfigured.

### Personal-avatar gate — be honest about what it proves

`_FEATURE.md` requires "only the personal avatar may be used as a twitch bot (user-is-creator)".
**The API cannot currently answer that question.**

- **Membership in `/list_user_avatars` proves _access_** — rules out typos, deleted avatars, and any
  stranger's public avatar. It does **not** prove authorship, and cannot distinguish "created by this
  account" from "shared into it" via `POST /share_avatar`.
- **Weak positive signal**: `graph_id === "Anubis"`; warn when it differs.
- **Operator attestation**: `acknowledgedAsPersonalAvatar: true` in `bots.json`, refused to start
  without, after the summary has printed the avatar's name and description.
- **The real fix (file upstream)**: have `list_user_avatars` and `GET /assistants/{id}` echo
  `is_personal_avatar_of_creator` and a `creator_user_id`. Ship
  `neuralNexusApiClient.resolveAvatarOwnership(assistantIdentifier)` →
  `"personal" | "owned" | "shared" | "unknown"`, hard-coded to `"unknown"` with a single `TODO`
  marking the exact line to change. That is the seam.

---

## Repo changes

- **`.env.example`** (no values, per CLAUDE.md): `NEURAL_NEXUS_API_KEY`,
  `NEURAL_NEXUS_API_BASE_URL`, `BOTS_CONFIG_PATH`, `CLIENT_ID`, `TWITCH_OAUTH_TOKEN_ANUBIS`,
  `LOG_LEVEL`, plus commented tuning knobs (`TWITCH_CHAT_MESSAGES_PER_SECOND`,
  `MAXIMUM_REPLY_CHUNK_COUNT`, `PER_CHATTER_COOLDOWN_SECONDS`, `NEURAL_NEXUS_STREAMING_ENABLED`,
  `NEURAL_NEXUS_STREAM_IDLE_TIMEOUT_SECONDS`, `NEURAL_NEXUS_STREAM_TOTAL_TIMEOUT_SECONDS`,
  `NEURAL_NEXUS_MAXIMUM_CONCURRENT_REQUESTS`) and the single-bot fallback block.
- **`.gitignore`** — add `bots.json`. Commit `api-1.json` deliberately (anubis-discord commits its
  copy; it is the contract this code is written against).
- **`Dockerfile`** — `COPY index.js oauth-server.js oauth-url.js ./`, `COPY src ./src`,
  `COPY scripts ./scripts`; `CMD ["node", "index.js"]`; add `USER node`.
- **`docker-compose.bot.yml`** — mount `./bots.json:/app/bots.json:ro`, set `BOTS_CONFIG_PATH`,
  `stop_grace_period: 15s` so the send queue drains.
- **`package.json`** — `start` → `node index.js`, add `test` (`node --test`) and `probe`.
- **`oauth-server.js` / `oauth-url.js`** — read `OAUTH_TOKEN_VARIABLE_NAME` (default `OAUTH_TOKEN`)
  so the callback page prints `TWITCH_OAUTH_TOKEN_ANUBIS=<token>`; authorizing a third bot account
  must not produce a third line saying `OAUTH_TOKEN=`. Scopes unchanged — adding moderation scopes
  now would force everyone to re-authorize before the feature exists.
- **`README.md`** — rewrite: multi-bot topology, `bots.json` reference, env table, the
  one-thread-per-channel model and what `!new` does, the chat surface, a troubleshooting table
  mapping each chat error line to its cause, and an explicit "what the personal-avatar check does and
  does not verify" section. Delete the `HeyGuys`/`VoHiYo` description.

---

## Verification

1. `npm run probe -- --assistant-id=47cfdaa2-… --message="Say hello in five words."` → frame types
   match the documented shape; note time-to-first-token and time-to-`done`.
2. Same with `--no-stream` → JSON body has `content` and `thread_id`.
3. Re-run streaming with `--thread-id=<from step 1>` → `GET /conversations` still shows **one**
   thread and `/conversations/{thread_id}/messages` has both turns. This is what validates the
   one-thread-per-channel model.
4. `npm test` — chunker, parser, queue, router, configuration.
5. Start **one** bot, one channel; confirm the summary names the right avatar and the socket subscribes.
6. `@botname hello` → one reply prefixed `@yourname`, within ~20 s.
7. `@botname write me a 600 word essay about ancient Egypt` → ≤3 lines, each ≤500 chars, ordered,
   `(2/3)` markers, ends with the truncation marker.
8. Two viewers mention simultaneously → replies do not interleave; the second waits; check the
   timing log line.
9. Same viewer twice inside 20 s → second silently ignored, `debug` line recorded.
10. `!new` as broadcaster/moderator → thread cleared, next question shows no memory. As a
    non-moderator → refused.
11. `!help`, `!avatars`, `!whoami` → one line each, under 500 chars.
12. `docker network disconnect` for 90 s → keepalive watchdog fires, backoff logs, reconnect,
    mention answered. **No duplicate replies.**
13. `session_reconnect` is hard to trigger on demand → unit-test the transition with a fake socket:
    new socket welcomes before the old closes, and **no** duplicate subscription is created.
14. Bogus API key → the 401 line appears exactly once per 10 minutes, socket stays up.
15. Inject a 402 in a test harness → gate opens, later mentions make **zero** HTTP requests.
16. Add a second bot + second avatar in the same channel → each answers only for itself, neither
    answers the other, a bare `!help` produces exactly one response.
17. `docker compose down` mid-reply → in-flight chunks drain, no stack trace.

---

## Seams for the future phases

**Phase 2 (respond / notify / ignore over the whole stream)** — one function,
`responsePolicy.decideResponseForChatMessage({botConfiguration, chatMessageEvent, channelState,
recentChatMessages}) → {action, promptText, reason}` with `action ∈ respond | command | ignore |
notify`. Today it returns `respond` only on an alias match. Phase 2 replaces the body with a
classifier or an avatar call and **nothing downstream changes** — router, queues, chunker, and send
queue already accept `ignore` and `notify`. `recentChatMessageBuffer` is populated from day one and
feeds `your_description`. `ownerNotifier.notifyOwner(...)` exists and logs at warn today.

**Phase 3 (learned moderation)** — `twitchHelixClient.js` is shaped so `deleteChatMessage`,
`banUser`, `timeoutUser` are ten-line additions sharing the same auth and 429 handling; the router
already carries `event.message_id` and `event.badges` to the policy. `oauth-url.js` gains
`TWITCH_MODERATION_SCOPES` and a scope-profile argument — note those scopes are granted by the
**broadcaster**, not the bot, so `oauth-server.js` also grows a broadcaster mode printing a
different variable name.

**Persistence** — `conversationThreadStore` is an interface (`getThreadIdentifier`,
`setThreadIdentifier`, `clearThreadIdentifier`) with an in-memory implementation. In-memory is
correct for Phase 1: a restart losing channel context is acceptable, arguably desirable. Dropping in
`anubis-discord/src/storage/repository.js`'s Postgres pattern later is a one-file change.

**Cross-repo** — keeping `serverSentEventStream.js` / `logger.js` / `describeErrorBody` structurally
identical to anubis-discord is the strongest argument for eventually extracting a shared
`neural-nexus-client` package, once `anubis-slack` (currently plan-only) needs the same code.

---

## Note

The API key was pasted into this conversation. It now lives in shell history and this session's
transcript — rotate it via `POST /rotate_api_key` before anything goes to production.

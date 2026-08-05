# Investigation: Twitch indefinite suspension for Fraud

**Repository:** `AfterlifeSystems/anubis-twitch`
**Branch investigated:** `test` (identical to `main` and `dev` at `921cc27`)
**Date:** 2026-08-04

---

## Summary

The chat bot implementation in `bot.js` is not the cause of the suspension. `bot.js`
is the official Twitch example chatbot reproduced near-verbatim, using the documented
EventSub WebSocket plus Helix path with the correct scopes. Nothing in the chat
behavior — listen for `HeyGuys`, reply `VoHiYo`, back off on HTTP 429 — violates
Twitch policy.

The Fraud classification comes from **how the OAuth credentials were obtained and how
the Twitch API was addressed**, not from what the chat bot did with those credentials.
Two clear violations are present in this repository, and one of the two violations is a
textbook fraud signature.

A third issue, unrelated to the suspension, is a credential leak: a full Chromium
browser profile was committed and pushed to a public repository.

### Caveat on sourcing

The two Twitch policy pages referenced in the bug report — the Community Guidelines
article and the chatbot guide's linked policy material — are JavaScript-rendered and
returned no body text when fetched. The Terms of Service page at `legal.twitch.com`
behaved the same way. **The policy mapping in this report is therefore an assessment,
not quoted policy text.** The code evidence below is directly verified and is the
reliable part of this report.

The one policy document that did return usable content, the chatbot guide at
`dev.twitch.tv/docs/chat/chatbot-guide/`, confirms the supported authentication
approach (OAuth token, scopes `user:bot` / `user:read:chat` / `user:write:chat`,
validation through `/oauth2/validate`) and notes that **chatbot verification is
currently temporarily paused**.

---

## Finding 1 — Automated headless login that deliberately worked around Twitch bot detection

**Severity: critical. Most probable cause of the Fraud classification.**

The Python source file was deleted, but the compiled bytecode survives at
`__pycache__/oauth-headless.cpython-312.pyc` and preserves the docstring and all
string constants. The docstring reads:

> True headless Twitch login + implicit OAuth using TWITCH_BOT_USERNAME /
> TWITCH_BOT_PASSWORD from .env (nodriver + Google Chrome, headless=True).
> No client secret. No visible window / Xvfb. Captures access_token from the
> redirect URL hash and writes OAUTH_TOKEN into .env.
> **Twitch's passport integrity check may still reject automated browsers with
> "Your browser is not currently supported."** When that happens, docker-entrypoint
> falls back to manual approval via oauth-server.js.

Recovered string constants show the script driving `https://www.twitch.tv/login`,
filling the `#login-username` and `#password-input` fields, clicking
`button[data-a-target="passport-login-button"]`, and branching on the literal needle
`"browser is not currently supported"` with the error
`Twitch rejected the automated browser`.

Three properties make this finding severe:

1. **`nodriver` is not a general-purpose automation library.** The `nodriver` package
   is specifically an anti-bot-detection Chrome driver. Selecting `nodriver` over a
   conventional automation library is selecting evasion.

2. **The script detects the Twitch integrity block by name and iterates against that
   block.** Hardcoding the exact rejection string and handling the rejection as a
   retry condition documents intent to circumvent an access control. This is not an
   incidental automation side effect.

3. **The script targets `passport.twitch.tv`**, the Twitch identity service, with
   scripted username and password submissions originating from a headless browser
   inside a Docker container. From the Twitch side, that traffic pattern is
   indistinguishable from credential stuffing or account takeover, regardless of the
   fact that the account belongs to the operator running the script.

The successor implementation went further. Per the recorded design notes, the later
`oauth-headless.js` stopped attempting login entirely and instead **seeds the bot
account `auth-token` session cookie from a `TWITCH_BOT_AUTH_COOKIE` value in `.env`**,
then opens the authorize URL against that pre-authenticated session. Injecting a
session token to bypass authentication is the single strongest account-integrity
violation present in this project.

---

## Finding 2 — Impersonating the Twitch first-party web client against the private GraphQL API

**Severity: critical. Maps most directly to the word "Fraud."**

`get-user-id.sh:24`:

```bash
BODY="$(curl -sS 'https://gql.twitch.tv/gql' \
  -H 'Client-Id: kimne78kx3ncx6brgo4mv6wki5h1ko' \
  -H 'Content-Type: application/json' \
  --data "{\"query\":\"query{user(login:\\\"${LOGIN_LC}\\\"){id login displayName}}\"}")"
```

The value `kimne78kx3ncx6brgo4mv6wki5h1ko` is **the Twitch first-party `twitch.tv` web
application Client-ID**. Sending that Client-ID causes every request from this script
to claim to be the Twitch website itself. That is misrepresentation of client
identity, which maps to a fraud classification more directly than any other behavior
in this repository.

The request also targets `gql.twitch.tv`, an undocumented private endpoint that is not
part of the published Twitch API surface.

The script's own comment block at `get-user-id.sh:6-8` documents the legitimate
supported replacement immediately above the violating line:

```
#   curl -s 'https://api.twitch.tv/helix/users?login=<login>' \
#     -H "Authorization: Bearer <token>" -H "Client-Id: <client_id>"
```

This script was committed in `ac158a8` ("added helper script to get user ids") and is
published on the public GitHub repository, making the violation discoverable evidence
tied to the developer application and the Twitch account.

---

## Finding 3 — Persistent device fingerprint reused across automated sessions

**Severity: moderate. Explains how the suspension propagated to the account level.**

The committed browser profile at `.browser-profile-host/Default/Cookies` contains the
Twitch durable device identifiers:

| Host | Cookie |
|---|---|
| `.twitch.tv` | `unique_id` |
| `.twitch.tv` | `unique_id_durable` |
| `.twitch.tv` | `api_token` |
| `.twitch.tv` | `experiment_overrides` |
| `.twitch.tv` | `twitch.lohp.countryCode` |

The design notes confirm the browser profile was intentionally persisted, in a Docker
volume, so that token renewals stayed automatic across runs. Persisting that profile
also persisted `unique_id_durable`, meaning a single stable device fingerprint links
the automation, the bot account, the registered developer application, and the primary
account into one identity cluster. That linkage is the mechanism by which a violation
committed by the bot account results in an account-level suspension rather than a
bot-account-only suspension.

---

## Why the classification is "Fraud" rather than "Spam" or "Bot Abuse"

The Twitch fraud category covers misrepresentation of identity and circumvention of
platform controls. Two independent behaviors in this repository land in that category:

- **Misrepresentation of identity** — forging the first-party Client-ID, so that
  requests claim to originate from the Twitch web client (Finding 2).
- **Circumvention of platform controls** — session-token injection and scripted
  authentication against the Twitch passport identity service, in both cases
  explicitly designed around a detection mechanism the author had already encountered
  (Finding 1).

Chat spam or unwanted bot messaging would have produced a chat-scoped timeout or a
channel-level restriction, not an indefinite account suspension. The indefinite scope
of the suspension is consistent with an authentication and identity finding rather
than a content or messaging finding.

---

## Separate issue: leaked credentials in a public repository

This issue is not believed to have caused the suspension, but requires action.

Commit `d23444a` ("adding basic functional code") committed the entire Chromium
browser profile — **223 files** — and those files are currently pushed to `main`,
`dev`, and `test` on the public repository
`https://github.com/AfterlifeSystems/anubis-twitch`. The committed files include
`Default/Cookies`, `Default/Login Data`, and `Default/Login Data For Account`.

**Root cause:** `.gitignore:4` ignores `.browser-profile/`, but the directory that was
actually created is named `.browser-profile-host/`. The ignore pattern therefore never
matched.

**Exposure assessment:**

- No `auth-token` cookie is present in the committed cookie store, so the Twitch
  session token itself did not leak. This was verified by reading the SQLite cookie
  database directly.
- The `api_token` cookie is present and should be treated as exposed.
- The `Login Data` databases are encrypted at the operating-system level and are
  likely empty, but should be treated as exposed.
- `.env` is correctly ignored and is not tracked. The live `OAUTH_TOKEN` did not leak
  through version control.

---

## Recommended actions

### Immediate

1. Rotate `OAUTH_TOKEN`, and rotate `TWITCH_BOT_AUTH_COOKIE` if that variable still
   exists in `.env`.
2. Change the bot account password.
3. Purge `.browser-profile-host/` from the full git history using `git filter-repo`,
   then force-push `main`, `dev`, and `test`.
4. Correct `.gitignore` to cover `.browser-profile-host/` as well as
   `.browser-profile/`.
5. Delete `__pycache__/oauth-headless.cpython-312.pyc`.

### Before submitting an appeal

6. Delete `get-user-id.sh`, or rewrite the script to call the supported Helix endpoint
   `https://api.twitch.tv/helix/users?login=<login>` using the project's own
   registered Client-ID and a Bearer token.
7. Remove every remaining trace of the headless login path from the working tree and
   from git history.

An appeal is substantially stronger once the public repository no longer contains the
violating code.

### Appeal content

Be direct and specific rather than general. The strongest available position is
factual:

- OAuth was automated for a personal bot account owned by the operator.
- The hardcoded Client-ID was copied from a public snippet without the operator
  understanding that the value was the Twitch first-party client identifier.
- No monetary fraud occurred, and no third-party account was accessed.
- The violating code has been removed.

Twitch appeals respond better to a specific admission with concrete remediation than
to a general denial.

### Going forward

The multi-avatar, multi-bot goal described in `_FEATURE.md` should use the
**Authorization Code grant with a client secret and refresh tokens**. That grant
provides unattended token renewal with no browser automation of any kind, which is
precisely the problem the headless login path was built to solve. The implicit grant
currently used in `oauth-url.js` (`response_type=token`) cannot issue refresh tokens,
which is what forced the browser automation in the first place. Switching the grant
type removes the root cause.

Note also that the chatbot guide states chatbot verification is temporarily paused.
That pause is relevant to the plan in `_FEATURE.md` to run one distinct Twitch bot per
avatar, because unverified bots are subject to lower messaging rate limits.

---

## Evidence index

| Artifact | Path | Relevance |
|---|---|---|
| Chat bot implementation | `bot.js` | Cleared — official example, no violation |
| Private GraphQL call with forged first-party Client-ID | `get-user-id.sh:24` | Finding 2 |
| Compiled headless login automation | `__pycache__/oauth-headless.cpython-312.pyc` | Finding 1 |
| Automation failure screenshots | `.cursor/oauth-failure.png`, `.cursor/oauth-failure-host.png` | Finding 1 |
| Entrypoint OAuth mode log | `.cursor/debug-fae4a2.log` | Finding 1 |
| Committed browser profile with device identifiers | `.browser-profile-host/Default/Cookies` | Finding 3, credential leak |
| Ignore pattern that failed to match | `.gitignore:4` | Credential leak root cause |
| Implicit grant, no refresh token | `oauth-url.js` | Root cause of the automation |

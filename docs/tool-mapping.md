# Pion Tool Mapping (Step 2 deliverable)

Sorting of the Pi developer surface into what Pion can expose as MCP tools.
Derived from `pi-sdk-notes.md`. This file tracks the build scope tier by tier.

---

## Wrappable now (server-side, no Pi Browser required)

### Tier A — zero-permission chain reads (Horizon/Stellar)
No API key, no user consent needed. Safest possible starting tools.

| Tool | Backing call | Status | Notes |
|---|---|---|---|
| `get_wallet_balance` | Horizon `GET /accounts/{address}` | ✅ shipped v0.1.0 | Pi + any custom token balances |
| `get_account_payments` | Horizon `GET /accounts/{address}/payments` | ✅ shipped v0.1.0 | payment history |
| `query_transaction` | Horizon `GET /transactions/{txid}` | ✅ shipped v0.1.0 | verify a specific tx |

### Tier B — Platform API with user access token
| Tool | Backing call | Status | Notes |
|---|---|---|---|
| `verify_user` | `GET /v2/me` (Bearer token) | ✅ shipped v0.2.0 | validates a token, returns uid/username |

### Tier C — Platform API with Server API Key
| Tool | Backing call | Status | Notes |
|---|---|---|---|
| `send_payment` (A2U) | `POST /payments` + Stellar tx + `/complete` | ⚠️ on main, unreleased; success path untested | **testnet only**; off unless armed |
| `get_payment_status` | `GET /payments/{id}` | planned | |
| `list_incomplete_payments` | `GET /payments/incomplete_server_payments` | planned | recovery/hygiene tool |
| `approve_payment` | `POST /payments/{id}/approve` | planned | backend half of U2A |
| `complete_payment` | `POST /payments/{id}/complete` | planned | backend half of U2A |
| `cancel_payment` | `POST /payments/{id}/cancel` | planned | |

## Testnet only (platform restriction, not ours)
- All A2U payments (`send_payment`) — per payments_advanced.md
- Token creation, trustlines, liquidity pools (Stellar ops from tokens guide) —
  candidate later tools: `create_token`, `establish_trustline` (deferred past v0.1)

## Not exposable via MCP (Pi Browser client-side only)
- `Pi.authenticate` — Browser consent dialog
- `Pi.createPayment` — U2A *initiation* (wallet signing UI lives in Pi Browser)
- Ads module (show/request/isReady), share dialog, nativeFeaturesList,
  openUrlInSystemBrowser, PiNet metadata
- `payments` scope over Pi Sign-in — not shipped yet by Pi (watch item)

---

## Build status

**v0.1.0 / v0.1.1 — Tier A, published to npm.** `get_wallet_balance`,
`get_account_payments`, `query_transaction`. Zero permissions, zero secrets,
verified end-to-end against live testnet Horizon. The full MCP loop
(Claude ⇄ Pion ⇄ Pi chain) is proven.

**v0.2.0 — Tier B, published to npm.** `verify_user`. Rejection path verified
against the live Platform API; the success path still needs a real user token
(see open questions below).

**Unreleased — Tier C begins.** `send_payment` (A2U). Off unless armed by four
separate conditions: `PION_ENABLE_PAYMENTS=1`, a mandatory `PION_MAX_PAYMENT_PI`
ceiling, both credentials, and a testnet Horizon URL. Credentials alone do not
arm it. Not registered at all when disarmed, so a default server does not
advertise a spend tool.

Guards, the cap boundary, and the create-step failure are verified
(`npm run arming`). **The success path has never run** — it needs a real server
API key and a funded testnet wallet. Sign, submit, and complete are unproven.

**Next.** The rest of Tier C: payment status, incomplete-payment recovery, and
the U2A backend half.

### Correction to the original plan

This file previously said Tier B would sit behind env-config alongside Tier C.
That was wrong, and the shipped implementation departs from it: a user access
token is **per-user and per-session**, not server configuration. `verify_user`
therefore takes the token as a call argument and never reads it from the
environment. Env-config remains correct for Tier C, where the server API key
and wallet secret genuinely are server-owned.

## Design implications recorded
1. U2A initiation is architecturally impossible from MCP — Pion positions as
   (a) read layer, (b) A2U sender, (c) U2A *backend* companion to a Pi-Browser frontend.
2. A2U = the "agent pays human" primitive; combined with the allowance-delegation
   concept, the app wallet becomes the agent's leashed spending account.
3. Open questions — still unanswered after the Tier A/B/C build:
   - Mainnet Horizon URL + network passphrase
   - Whether GET /payments requires the payment to belong to our app (Tier C)
   - A2U end-to-end latency and failure modes (incomplete payment recovery) (Tier C)
   - **Length of a Pi payment identifier.** A2U requires it as the Stellar text
     memo, which is capped at 28 bytes. Now looks likely to be a real problem:
     Pi uses 36-character UUIDs for uids in the same API, and 36 > 28. If
     payment ids follow the same convention the memo approach cannot work as
     written. `send_payment` checks after create and before signing, so it
     fails safely — but the answer decides whether the design holds.
   - Whether `POST /v2/payments` returns the recipient wallet address on the
     create response, as assumed, or requires a separate lookup.

## Resolved

- **`GET /v2/me` response shape** — confirmed against a live token:
  `{ app_id, uid, credentials: { scopes[], valid_until: { timestamp, iso8601 } },
  receiving_email, username }`. The nesting `verify_user` assumed was correct;
  it now also surfaces `app_id`, which matters because a token issued for a
  *different* app is still a valid token and must not be trusted.
- **Pi Sign-in works outside the Pi Browser** via implicit flow, but consent
  still happens in the Pi Browser: the desktop page shows a QR code, which the
  phone app picks up. Granted scopes came back as `platform` and `username`.

## Observed during the build (not in the source docs)

- Horizon's `/accounts/{id}/payments` returns more than classic payments on Pi
  testnet — Soroban `invoke_host_function` records appear in the same feed, and
  they carry no asset fields. Do not assume every record is a native transfer.
- Horizon always emits a `_links.next` cursor, even past the end of a result
  set, so its presence is not a "more results" signal.
- `GET /v2/me` returns **401 with an empty body** — no JSON error document.
  Error handling that assumes a parseable body will throw on the most common
  failure case.
- Accounts hold `liquidity_pool_shares` balances keyed by `liquidity_pool_id`
  rather than a code/issuer pair.
- Pi uids are 36-character UUIDs, not opaque short ids. Relevant because the
  A2U memo budget is 28 bytes.
- `/v2/me` returns an `app_id` and a `receiving_email` flag that the platform
  docs do not mention.

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
| `get_payment_status` | `GET /payments/{id}` | planned as a tool; endpoint ✅ live-verified 2026-07-31 | exercised by the approve function's pre-approval read |
| `list_incomplete_payments` | `GET /payments/incomplete_server_payments` | planned | recovery/hygiene tool |
| `approve_payment` | `POST /payments/{id}/approve` | planned as a tool; endpoint ✅ live-verified 2026-07-31 | backend half of U2A; shipped as a Netlify function, not yet an MCP tool |
| `complete_payment` | `POST /payments/{id}/complete` | planned as a tool; endpoint ✅ live-verified 2026-07-31 | backend half of U2A; shipped as a Netlify function, not yet an MCP tool |
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

**U2A backend — live-verified 2026-07-31.** A real 0.314 Test-Pi payment ran end
to end through `site/pay.html` and the two Netlify functions in `netlify/`:
Pi Browser initiation → `GET /v2/payments/{id}` → `POST /approve` →
`POST /complete`, all against the production Platform API with a server API key.
This closed the final Developer Portal checklist item.

What that does and does not establish: the three Platform API calls behind
`get_payment_status`, `approve_payment`, and `complete_payment` are now proven
against live infrastructure, including the server-key auth path. **None of them
is an MCP tool yet** — the working implementation is a pair of Netlify functions
serving a browser, so exposing them through Pion is still a port, not a wrap.
It also says nothing about A2U, which is a different endpoint (`POST /payments`)
and a different failure surface.

Operational detail — what to capture on failure, how to read a 409/502/404, and
the stuck-payment recovery path — is in `runbook.md`. `npm run u2a` covers the
functions against a local stub.

**Next.** The rest of Tier C: payment status, incomplete-payment recovery, and
porting the U2A backend half from Netlify functions into MCP tools.

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
   Position (c) is no longer theoretical: a Pi-Browser frontend handed our server a
   paymentId and the server carried the approve/complete halves (2026-07-31).
2. A2U = the "agent pays human" primitive; combined with the allowance-delegation
   concept, the app wallet becomes the agent's leashed spending account.
3. Open questions — still unanswered after the Tier A/B/C build:
   - Mainnet Horizon URL + network passphrase
   - Whether GET /payments requires the payment to belong to our app (Tier C).
     Half-answered 2026-07-31: it definitely *works* for a payment that does
     belong to us. Whether a foreign payment id is refused is still untested,
     and that is the half that matters for security.
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
- **A Pi Sign-in `wallet_address` grant does not appear to satisfy A2U.**
  Reproduced with a valid server API key, an attached app wallet, and a fresh
  token whose `/v2/me` lists `wallet_address` among granted scopes: create
  still fails with `missing_scope` for that same uid. The two surfaces read
  different grant records. This matches the documented split — identity flows
  out of the Pi Browser via Sign-in, payment authorization does not — and
  suggests A2U recipients must authorize through the Pi Browser SDK
  (`Pi.authenticate`), not Pi Sign-in. **Unconfirmed**; the remaining
  alternative is that the OAuth client and the server API key belong to
  different apps, which would make the uid meaningless to the paying app.
  If it holds, the "agent pays human" primitive is limited to users onboarded
  through the Pi Browser, which is materially narrower than the docs imply.
- **A2U requires the recipient to have granted the `wallet_address` scope.**
  Undocumented in the A2U guide, and it is the recipient's consent that is
  missing, not the app's. `POST /v2/payments` returns `401 missing_scope` —
  a status that otherwise means "bad API key", so the body must be read to
  tell a consent problem from a credential problem. Sending Pi to a user
  therefore requires them to have signed in and approved wallet_address first;
  a uid alone is not sufficient.
- `/v2/me` returns an `app_id` and a `receiving_email` flag that the platform
  docs do not mention.
- **A U2A payment identifier fits `[A-Za-z0-9_-]` and is at most 64 characters**
  — the approve function validates against that charset before interpolating the
  id into a request path, and a real payment passed through it (2026-07-31).
  That bounds the format but does not pin the length, so it does not settle the
  28-byte memo question on its own. Note that a U2A id is a free data point on
  that question: both directions are records in the same `/v2/payments`
  collection and are very likely to share a format, so the id logged by a U2A
  run is worth measuring as a cross-check against the A2U probe. Likely, not
  proven — `probe-a2u.mjs` remains the authoritative answer for A2U.

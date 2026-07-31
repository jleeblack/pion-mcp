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
| Tool | Backing call | Notes |
|---|---|---|
| `send_payment` (A2U) | `POST /payments` + Stellar tx + `/complete` | **testnet only currently** |
| `get_payment_status` | `GET /payments/{id}` | |
| `list_incomplete_payments` | `GET /payments/incomplete_server_payments` | recovery/hygiene tool |
| `approve_payment` | `POST /payments/{id}/approve` | backend half of U2A |
| `complete_payment` | `POST /payments/{id}/complete` | backend half of U2A |
| `cancel_payment` | `POST /payments/{id}/cancel` | |

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

**Next — Tier C.** A2U payments behind env-config (`PI_SERVER_API_KEY`,
`PI_WALLET_SECRET`), testnet-default with explicit opt-in for anything that
moves value.

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
3. Open questions — still unanswered after the Tier A/B build:
   - Mainnet Horizon URL + network passphrase
   - Whether GET /payments requires the payment to belong to our app (Tier C)
   - A2U end-to-end latency and failure modes (incomplete payment recovery) (Tier C)
   - `GET /v2/me` success-response shape. The implementation follows the platform
     docs, not observed traffic: `uid` is treated as guaranteed, `username` and
     `credentials.scopes` as scope-dependent and optional. Needs a real user
     token to confirm.

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

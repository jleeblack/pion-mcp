# Pion Tool Mapping (Step 2 deliverable)

Sorting of the Pi developer surface into what Pion can expose as MCP tools.
Derived from `pi-sdk-notes.md`. This file defines the v0.1 build scope.

---

## Wrappable now (server-side, no Pi Browser required)

### Tier A — zero-permission chain reads (Horizon/Stellar)
No API key, no user consent needed. Safest possible starting tools.

| Tool | Backing call | Notes |
|---|---|---|
| `get_wallet_balance` | Horizon `GET /accounts/{address}` | Pi + any custom token balances |
| `get_account_payments` | Horizon `GET /accounts/{address}/payments` | payment history |
| `query_transaction` | Horizon `GET /transactions/{txid}` | verify a specific tx |

### Tier B — Platform API with user access token
| Tool | Backing call | Notes |
|---|---|---|
| `verify_user` | `GET /v2/me` (Bearer token) | validates a token, returns uid/username |

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

## v0.1 build scope (Step 3)

Ship Tier A only: `get_wallet_balance`, `get_account_payments`, `query_transaction`.

Why: zero permissions, zero secrets, works against public testnet Horizon immediately,
and proves the full MCP loop (Claude ⇄ Pion ⇄ Pi chain) with no regulatory or
security surface at all.

v0.2 adds Tier B/C behind env-config (`PI_SERVER_API_KEY`, `PI_WALLET_SECRET`),
testnet-default with explicit opt-in for anything that moves value.

## Design implications recorded
1. U2A initiation is architecturally impossible from MCP — Pion positions as
   (a) read layer, (b) A2U sender, (c) U2A *backend* companion to a Pi-Browser frontend.
2. A2U = the "agent pays human" primitive; combined with the allowance-delegation
   concept, the app wallet becomes the agent's leashed spending account.
3. Open questions to verify in Step 3 against live testnet:
   - Mainnet Horizon URL + network passphrase
   - Whether GET /payments requires the payment to belong to our app
   - A2U end-to-end latency and failure modes (incomplete payment recovery)

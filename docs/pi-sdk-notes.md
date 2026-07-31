# Pi SDK Research Notes (Step 2)

Working notes from reading [pi-apps/pi-platform-docs](https://github.com/pi-apps/pi-platform-docs/tree/master),
the Pi Sign-in integration guide, and the testnet tokens guide.
These notes are in our own words; always defer to the linked source docs.

Last reviewed: July 2026

---

## Architecture: three distinct layers

Pi's developer surface is actually three separate systems with different access models.
Understanding which layer an operation lives in determines whether Pion can expose it.

### Layer 1 — Client JS SDK (Pi Browser only)
- Loaded via `<script src="https://sdk.minepi.com/pi-sdk.js">`, exists as `window.Pi`
- Docs state explicitly: **"This SDK is not for a server-side NodeJS app."**
- Contains: `Pi.authenticate`, `Pi.createPayment` (U2A initiation), Ads module,
  share dialog, `nativeFeaturesList`, `openUrlInSystemBrowser`
- **Consequence for Pion: none of this is directly callable from an MCP server.**
  U2A payment *initiation* requires the user to be inside the Pi Browser.

**`sandbox` — where the page runs, not which chain it touches.**
`Pi.init({ version: "2.0", sandbox: true })` points the app at the sandbox
environment at `sandbox.minepi.com`, reached through a development URL configured
in the Developer Portal (Client SDK reference, Initialization). It is orthogonal
to Mainnet/Testnet, which is fixed at app registration — a testnet-registered app
moves Test-Pi with the flag either way. In the real Pi Browser, sandbox must be
off; `sandbox: false` does **not** mean real Pi.

Because the two are easy to confuse, our pages default the flag to their own
primary use rather than sharing one default: `site/pay.html` defaults it **off**
(its purpose is the on-phone Pi Browser test, `?sandbox=1` to opt in), and
`scripts/browser-auth/index.html` defaults it **on** (a desktop dev tool,
`?sandbox=0` to opt out).

### Layer 2 — Platform API (`api.minepi.com/v2`) — server-side
Two auth mechanisms:
1. **Bearer access token** (a user's token) — e.g. `GET /v2/me` to verify identity.
   Callable from any server. Token originates from Pi Browser auth OR Pi Sign-in OAuth.
2. **Server API Key** (`Authorization: Key <key>`) — server-only, must never reach clients.
   Unlocks the payments endpoints:
   - `POST /payments` — **create App-to-User (A2U) payment** ← key capability
   - `GET /payments/{id}` — payment status
   - `POST /payments/{id}/approve` — server-side approval (U2A phase 1)
   - `POST /payments/{id}/complete` — server-side completion (both directions)
   - `POST /payments/{id}/cancel`
   - `GET /payments/incomplete_server_payments`
   - `GET /ads_network/status/:adId` — rewarded-ad verification

**A2U constraint (from payments_advanced.md): "currently available only on the Testnet."**

U2A note: initiation is Browser-locked (Layer 1), but the approve/complete halves are
plain server-side API calls — Pion can act as the *backend* of a U2A flow if a
Pi-Browser frontend hands it the paymentId.

### Layer 3 — The blockchain itself (Stellar/Horizon) — fully open
- Pi's chain is Stellar-based. The tokens doc uses `@stellar/stellar-sdk` directly
  against Horizon at `https://api.testnet.minepi.com` (network passphrase: `"Pi Testnet"`)
- **Read-only queries (account balances, transactions, payment history, ledgers)
  require no Pi permission, no API key, no Browser** — standard Horizon REST
- Writing (trustlines, token minting, raw payments) requires holding a wallet secret key
- TODO: confirm the mainnet Horizon URL and passphrase (docs cover testnet only)

---

## Pi Sign-in (OAuth) — identity outside the Pi Browser

- `accounts.pinet.com` — standard OAuth 2.0, **implicit flow only** (no client secret,
  no PKCE; auth-code flow "coming in a future release")
- Yields a short-lived bearer token → `GET api.minepi.com/v2/me` → `{ uid, username }`
- Scopes available: `username`, `wallet_address`
- **`payments` scope is NOT available for Pi Sign-in yet** — identity can flow out
  of the Pi Browser, payment authorization cannot. Watch for this scope shipping.
- `uid` is app-specific per user (same human = different uid in different apps —
  deliberate anti-correlation design)
- Requires: Developer Portal app, verified domain, registered redirect URIs
  (loopback `localhost`/`127.0.0.1` allowed without domain verification — good for dev)

---

## Developer Portal requirements

- Register at `develop.pi` inside the Pi Browser
- **App Network (Mainnet vs Testnet) is fixed at registration** — create two apps,
  one per network; testnet app shows black/yellow stripe in Pi Browser
- Checklist gates: hosting config → app wallet connection → domain verification
- Server API Key issued per app via the portal

## Backend SDKs (for A2U)
- Ruby: official (`pi-ruby`); Node.js: "coming soon" (official); Python/PHP: community
- Practical consequence: Pion will likely implement A2U against the raw Platform API +
  Stellar SDK rather than waiting on the official Node SDK

## Security notes for Pion
- Server API Key and app wallet secret live in env config only — never in code,
  never sent to clients, never committed (already excluded via .gitignore)
- U2A hostile-client warning from docs applies: never trust client-reported payment
  success; only `/complete` returning 200 confirms a payment

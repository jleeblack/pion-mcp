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

**Observed: an undocumented `platform` scope.** A `Pi.authenticate(["payments"])`
call returned `payments, platform` — a scope we did not request and that appears
in no documented scope list. Not a one-off, and not specific to the Browser SDK:
Pi Sign-in independently returned `platform` alongside `username` (see
`tool-mapping.md`). Two different auth surfaces both grant it, so it looks like
something Pi attaches to every grant rather than a per-app quirk. Purpose
unknown. Do not depend on it, and do not treat a returned scope set as equal to
the requested one — code that diffs granted against requested will see an extra
entry it never asked for.

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

**A2U constraint (observed, undocumented): the recipient must have granted
`wallet_address`.** `POST /v2/payments` is hard-gated on the *recipient's*
consent and refuses at creation — nothing is created, so there is nothing to
clean up. Verified 2026-07-31 against a uid that had authenticated through the
Browser SDK with `payments` only:

```
HTTP 401
{"error":"missing_scope",
 "error_message":"User hasn't authorized \"wallet_address\" scope for you to
                  access the public key."}
```

Two things make this easy to misdiagnose. It arrives as **401**, which
otherwise means "bad API key" — so the body must be read to tell a consent
problem from a credential problem. And the missing consent is the *recipient's*,
not the app's: the key is fine, the caller is fine, and a valid uid is not
sufficient. Sending Pi to a user requires them to have approved `wallet_address`
for your app first.

A 401 `missing_scope` also implies Pi resolved the uid *within the calling app*
— an unknown uid fails differently — so this error doubles as weak confirmation
that the uid and the server API key belong to the same app.

### `POST /v2/payments` rejects empty metadata (observed 2026-08-01)

```
HTTP 400
{"error":"invalid_metadata","error_message":"Metadata can't be empty."}
```

Undocumented, and `metadata` reads as an optional field. Sending `{}` fails;
any non-empty object is accepted.

**`metadata` is required and non-empty** — a constraint the Pi docs never state.

Worth noting *how* this hid. `probe-a2u.mjs` always sent `{ probe: true }`, so
every probe passed and the requirement was invisible — an assumption can be
exercised hundreds of times and still never be tested, if the test data happens
to satisfy it. It surfaced on the first send that omitted metadata.

**Where the three text fields actually surface**, established from a completed
A2U payment (tx `fb271ed0…`, 2026-08-01):

| Field | Where it goes |
|---|---|
| `metadata` | Pi's payment record only. Echoed by the Platform API; **never on-chain** |
| `memo` (the human note) | Pi's payment record only. Also **never on-chain** |
| the payment `identifier` | **This** is the on-chain Stellar `memo_text` — verified: `memo_type: "text"`, `memo: "lld5WBrilTeDoTvOybVdblJQCRAH"`, matching `payment_id` exactly |

So `send_payment`'s provenance default `{ source: "pion-mcp" }` is app-facing
bookkeeping in Pi's record. It cannot leak to the chain, because the chain memo
is spoken for by the identifier — that slot is not available to anything else,
which is also why the 28-byte budget has no headroom.

Whether Pi's own wallet UI displays `memo` or `metadata` to the recipient is
**unverified**; `memo` is the field described as human-readable, so it is the
likely candidate. Do not put anything in either field that would embarrass you
if shown to the user.

### A payment record cannot tell you whether funds moved (observed 2026-08-01)

**Pi learns a transaction's id only when `/complete` succeeds.** Until then the
record carries `transaction: null` and `transaction_verified: false` — and it
carries exactly that whether the transfer never happened or already landed.

Demonstrated by inducing both states deliberately (`runbook.md`, stranded
drill). A payment created but never submitted, and a payment whose transfer was
confirmed on-chain but whose `/complete` call was intercepted, produced
identical records.

Consequences for anything built on this API:

- `incomplete_server_payments` lists both, indistinguishably. **A listing is not
  a statement that nothing was sent.**
- Cancelling on the strength of `transaction: null` can cancel a payment the
  recipient has already received. Nothing in Pi's data prevents this, and the
  documentation does not warn about it.
- The only authority is the chain. The payment identifier is the on-chain
  Stellar text memo, so the transaction is findable: search the sending wallet's
  transactions for a successful one whose memo equals the identifier.

This is the strongest argument encountered for the memo design carrying the
identifier rather than anything else. It is what makes an orphaned transfer
recoverable at all.

### `POST /v2/payments` response shape (observed 2026-07-31)

From a live A2U create. Field names here are load-bearing and several are not
in the docs:

```jsonc
{
  "identifier": "tG76m134ce43WkPasVL8nCWLUomS", // 28 chars — fits memo_text exactly
  "amount": 1e-7,                  // JSON number, and small values arrive in
                                   // exponential notation — parse, don't string-match
  "direction": "app_to_user",
  "from_address": "G…",            // the app wallet
  "to_address": "G…",              // the RECIPIENT wallet — not `recipient`
  "user_uid": "…",
  "memo": "…",
  "network": "Pi Testnet",
  "transaction": null,             // until the on-chain tx is submitted
  "split_recipients": null,        // undocumented
  "token_canonical": null,         // undocumented
  "status": {
    "developer_approved": true,    // A2U is auto-approved at create
    "transaction_verified": false,
    "developer_completed": false,
    "cancelled": false,
    "user_cancelled": false
  }
}
```

Two things worth carrying forward. The recipient address **is** on the create
response, so A2U needs no separate wallet lookup — but it is `to_address`, and
code that guessed `recipient` gets `undefined` rather than an error. And A2U
comes back `developer_approved: true` already, confirming that `/approve` is a
U2A-only step: the app approving its own outgoing payment would be redundant.

U2A note: initiation is Browser-locked (Layer 1), but the approve/complete halves are
plain server-side API calls — Pion can act as the *backend* of a U2A flow if a
Pi-Browser frontend hands it the paymentId.

### Layer 3 — The blockchain itself (Stellar/Horizon) — fully open
- Pi's chain is Stellar-based. The tokens doc uses `@stellar/stellar-sdk` directly
  against Horizon at `https://api.testnet.minepi.com` (network passphrase: `"Pi Testnet"`)
- **Read-only queries (account balances, transactions, payment history, ledgers)
  require no Pi permission, no API key, no Browser** — standard Horizon REST
- Writing (trustlines, token minting, raw payments) requires holding a wallet secret key
- **Mainnet Horizon and passphrase — confirmed 2026-08-14** (was a TODO; Pi's own
  docs still cover testnet only). The URL follows the pattern. **The passphrase
  does not:**

  | | Horizon | Network passphrase |
  |---|---|---|
  | Testnet | `https://api.testnet.minepi.com` | `Pi Testnet` |
  | Mainnet | `https://api.mainnet.minepi.com` | **`Pi Network`** |

  Verified three ways. (1) Each node's root endpoint reports its own
  `network_passphrase`, which for a Stellar network is definitive — it is the
  string signatures are validated against. (2) Pi's production block-explorer
  bundle carries `REACT_APP_MAINNET_PRIMARY_API_URL:"https://api.mainnet.minepi.com"`
  and `REACT_APP_ENVIRONMENT:"PRODUCTION"`, confirming the URL first-party.
  (3) They are demonstrably different chains: distinct IPs, ledger heights
  ~2.05M apart, and the app wallet resolves on testnet while 404ing on mainnet.

  **The trap:** the string `"Pi Mainnet"` *does* appear in that same first-party
  bundle — once, as UI copy ("...has not been activated on the Pi Mainnet yet").
  It is a display label, and anyone extrapolating `Pi Testnet` → `Pi Mainnet`
  finds what looks like corroboration for a passphrase that would invalidate
  every signature made with it. `src/networks.ts` keeps `label` and `passphrase`
  as separate fields for exactly this reason.

  A **secondary** mainnet Horizon exists at `https://api2.mainnet.minepi.com`
  (`REACT_APP_MAINNET_SECONDARY_API_URL`), live and reporting the same
  passphrase. Documented, deliberately not wired as automatic failover: two
  hosts silently serving one client can disagree on ingestion lag, and a read
  that quietly changes source makes a later "the balance was wrong" impossible
  to reconstruct.

- **Mainnet base fee equals testnet's: 100,000 stroops (0.01 Pi).** From
  `/fee_stats` on both chains, 2026-08-14, and confirmed on a real mainnet
  transaction (`fee_charged: "100000"`, tx `f8b6d6c8…`). Mainnet showed no
  congestion spread at all — every percentile flat at 100,000 — while *testnet*
  showed p90 at 169,046. So the fee-floor arithmetic in `FINDINGS.md` §3 carries
  to mainnet unchanged. Not yet observed: the fee actually charged on a mainnet
  **A2U** payment, which Pi does not currently permit.

- **The same address can hold a balance on BOTH chains, with different amounts.**
  Measured 2026-08-14. `GCZYTVXS2K7DY3LJ6F3P5CVH3OU4ZGUKAXAUTE3K7NZGNH55ONISQCMB`
  held 2.0600000 Pi on mainnet (seq `107166829968883735`) and 32.2993800 Pi on testnet
  (seq `45199857865982412`) at the same moment. Sampling six recent mainnet
  accounts, three also existed on testnet and three 404'd — so it is common but
  not universal.

  **Why this matters more than it looks.** The intuition "if I query the wrong
  network I will get a not-found" is false. A wrong-chain read can return a
  well-formed, plausible, wrong number, with no error anywhere — the same shape
  of silent-wrong-answer as `FINDINGS.md` §4. This is the whole argument for
  labelling the network on every single result rather than only at startup, and
  it is what `npm run crossnet` guards.

  *Not claimed:* that Pi derives one keypair per passphrase across both
  networks. Co-existence proves the same public key is registered on both chains,
  not the mechanism. It does bear on the P0 question in `pre-mainnet.md` about
  shared key derivation, and is evidence in that direction, not an answer.
- **Block explorer: `blockexplorer.minepi.com/testnet`.** Serves the standard
  Stellar-explorer account view — payments, operations, signing tabs — which is
  more evidence that generic Stellar tooling conventions apply throughout, not
  just at the SDK level. A transaction is at
  `/testnet/tx/<hash>` (confirmed rendering 2026-08-01), and the page shows the
  fee in Pi rather than stroops.

  **It is a client-side app: every path returns HTTP 200**, including a bogus
  hash and outright nonsense, and the transaction data is not in the served
  HTML. A status-code check therefore proves nothing about an explorer link —
  the only way to verify one is to open it. Useful as an independent third verification source: a
  completed A2U payment was confirmed against tool report, raw Horizon, and this
  explorer, all three agreeing (2026-08-01).
- **App wallet transaction history was not findable inside Pi's developer
  surfaces** — the block explorer was the only Pi-provided view located.
  *Observed with uncertainty:* this may be a UI path that was missed rather than
  a real absence. If it holds, it means Horizon (and therefore Pion's own read
  tools) is the practical way to audit app wallet activity, which is a mildly
  satisfying argument for the read tools existing.

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

## App wallet history

The app wallet is the A2U sender: Pi records it as `from_address` on every
create, and a transaction signed by any other key cannot be matched to the
payment record.

| Address | Status | Notes |
|---|---|---|
| `GATQBZLI…CMLXBAIJA` | **current** — confirmed live in Pi 2026-08-01 02:44 UTC | testnet, funded 100 Pi |
| `GAXGSA34…QYWBUZWMT` | retired 2026-08-01 (Pi stopped using it at ~02:44 UTC) | seed deliberately exposed in an argv drill (see `runbook.md`); still holds 100 Pi, key is public — treat the balance as forfeit |
| `GBFVD7J2…VM4IZUOB4` | retired 2026-07-31 | secret unrecoverable — screenshot truncated, passphrase lost; ~100.9 Test-Pi abandoned with it |

Replacing a wallet is the recovery path when its secret is lost, because there
is no reset: a Stellar seed cannot be changed, only replaced. On testnet the
cost is the abandoned balance, which is worthless by definition. **On mainnet
the same loss is permanent and real** — which is the argument for capturing the
app wallet secret into a password manager at creation, in full, rather than
from a screenshot.

Nothing in this repo hardcodes the app wallet address; it is supplied per-run
to `npm run wallet` and recorded in `runbook.md`. Verified by grep at the time
of the swap, and worth re-checking if that ever changes.

### Creating an app wallet does not select it

**Creation and selection are separate steps in the Developer Portal, and only
selection changes what Pi spends from.** A newly created wallet sits alongside
the existing ones; the previously selected wallet stays selected until you
explicitly change it.

Established deliberately on 2026-08-01. A new wallet was created and left
unselected, to test whether Pi was genuinely still using the old one or whether
the Portal was merely showing stale state. `POST /v2/payments` returned
`from_address: GAXGSA34…`, the old wallet — Pi really was still spending from
it. After the selection was changed by hand, the next create returned
`from_address: GATQBZLI…`.

**Selection takes effect immediately.** A probe run within ~30 seconds of
changing it already returned the new wallet. So there is no sync gap and no
propagation delay: **Pi's `from_address` was accurate at every point**, and the
~6 minutes between the two probes was entirely human — the time taken to go and
click. An earlier version of this note recorded a Portal-versus-Pi
disagreement and a possible propagation delay; both were our inference rather
than observation, and both were wrong. `from_address` has never once
misreported the selected wallet.

Consequences worth keeping:

- **Creating a replacement wallet accomplishes nothing on its own.** If the
  reason for replacing it is a compromised key, the compromised wallet keeps
  spending until the selection changes. The exposure window is not something you
  wait out — it is however long you take to perform the second step, and it
  closes within seconds once you do. That is good news under pressure: the fix
  is fast, provided you know it is a separate action.
- **`from_address` on a create response is the only authoritative statement of
  which wallet is selected.** This is what makes gate 2b permanent: not because
  Pi lags, but because it is the one place the selection is observable.

### Old app wallets stay live and selectable

Retired wallets are not removed. They remain in the Portal's wallet selector
indefinitely — **no deletion mechanism was found** — and they remain funded,
real accounts on-chain.

The consequence is that a wallet retired *because its key leaked* stays one
mis-click away from being the app's spending account again. Retiring a wallet
in this project therefore means: stop selecting it, drain it, and treat its
balance as forfeit. It does not mean the wallet is gone, because it cannot be.

Unverified whether deletion exists on mainnet or is withheld on testnet
specifically. Worth establishing before a mainnet key ever leaks, because
"remove the compromised wallet" may simply not be an available action.

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

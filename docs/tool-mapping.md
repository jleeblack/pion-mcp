# Pion Tool Mapping (Step 2 deliverable)

Sorting of the Pi developer surface into what Pion can expose as MCP tools.
Derived from `pi-sdk-notes.md`. This file tracks the build scope tier by tier.

---

## Wrappable now (server-side, no Pi Browser required)

### Tier A — zero-permission chain reads (Horizon/Stellar)
No API key, no user consent needed. Safest possible starting tools.

**Both networks since v0.4.** Selected with `PION_NETWORK` (`testnet` default,
`mainnet`), resolved once in `src/networks.ts` and reported in every result's
`network` field. Mainnet selection makes Tier C unarmable — see below.

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
| `send_payment` (A2U) | `POST /payments` + Stellar tx + `/complete` | ✅ **success path live-verified 2026-08-01**; on main, unreleased | **testnet only**; off unless armed; **recipient must have granted `wallet_address`** — see constraint below |
| `get_payment_status` | `GET /payments/{id}` | planned as a tool; endpoint ✅ live-verified 2026-07-31 | exercised by the approve function's pre-approval read |
| `list_incomplete_payments` | `GET /payments/incomplete_server_payments` | planned | recovery/hygiene tool |
| `approve_payment` | `POST /payments/{id}/approve` | planned as a tool; endpoint ✅ live-verified 2026-07-31 | backend half of U2A; shipped as a Netlify function, not yet an MCP tool |
| `complete_payment` | `POST /payments/{id}/complete` | planned as a tool; endpoint ✅ live-verified 2026-07-31 | backend half of U2A; shipped as a Netlify function, not yet an MCP tool |
| `cancel_payment` | `POST /payments/{id}/cancel` | planned | |

## Testnet only (platform restriction, not ours)
- All A2U payments (`send_payment`) — per payments_advanced.md. Enforced by
  identity, not by URL inspection: arming requires the resolved network to *be*
  Pi Testnet, so `PION_NETWORK=mainnet` and any unrecognised endpoint are both
  refused, and the tool is not registered at all. Tier A reads are unaffected.
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
ceiling, both credentials, and Pi Testnet as the resolved network. Credentials
alone do not arm it. Not registered at all when disarmed, so a default server does not
advertise a spend tool.

Guards, the cap boundary, and the create-step failure are verified
(`npm run arming`).

**A2U success path — live-verified 2026-08-01.** `send_payment` moved real
Test-Pi end to end: create → sign → submit → complete, all three irreversible
steps, from the app wallet to a real recipient. Independently confirmed on
public Horizon rather than taken from the tool's own report:

| | |
|---|---|
| payment id | `lld5WBrilTeDoTvOybVdblJQCRAH` (28 bytes) |
| txid | `fb271ed0074847ec4bb62c76241d947f0e1439d4d3b056064f074db0f2bcc1cf` |
| ledger | 25933848, `successful: true` |
| from → to | `GATQBZLI…` (app wallet) → `GBZIHFFW…` (recipient) |
| amount | 0.0000001 Pi |
| on-chain memo | `memo_type: "text"`, `"lld5WBrilTeDoTvOybVdblJQCRAH"` — the identifier, exactly as designed |
| fee | 100,000 stroops = 0.01 Pi |

Two things this settles. The **memo design works in practice**, not just in
principle: the 28-byte identifier is what Pi matches the transaction by, and it
landed on-chain intact. And the **`to_address` fix was correct** — the payment
arrived at the right account, which the previous `recipient` field could never
have achieved.

One economic note worth carrying forward: the **fee was 100,000× the payment**.
Irrelevant for a minimum-amount test, and irrelevant for realistic amounts, but
it means dust-sized A2U payments are dominated by fees. Any batching or
micropayment design has to reckon with a flat per-transaction cost.

Still unproven: every failure path *after* create. Submit and complete have now
succeeded once each; they have never been observed failing against live
infrastructure, so `strandedReport`'s two worst branches remain untested by
anything but construction.

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

### Constraint on `send_payment`: recipient consent (confirmed 2026-07-31)

A2U payment creation is **hard-gated on the recipient's `wallet_address`
consent**, enforced by Pi at `POST /v2/payments` and refused before anything is
created. Full error shape in `pi-sdk-notes.md`. Reconfirmed against a uid that
had authenticated through the Browser SDK requesting `payments` only — so the
gate is about *which scopes were granted*, not about which surface granted them.

This is a permanent property of the tool, not a bug to fix: `send_payment` can
never pay an arbitrary uid. It can only pay users who have already consented to
receive from this app. Worth stating plainly in the tool description, because
"agent pays human" implies a reach the API does not provide.

**Requirement.** The tool must catch this specific 401 and surface *"the
recipient hasn't consented to receive payments from this app"* rather than a raw
scope error — a caller seeing `missing_scope` on a 401 will reasonably conclude
the API key is bad and go debug the wrong thing.

**Status: implemented 2026-07-31.** `platform.ts` branches on `missing_scope`
before blaming the credential and explains it as a consent problem;
`send_payment` routes it through `strandedReport("create")`, which correctly
reports that no payment was created and nothing needs cleanup. Both its
remediation text and `probe-a2u.mjs`'s previously pointed the caller at Pi
Sign-in; they now point at the Pi Browser SDK grant, which is the route we have
actually verified, while recording the Sign-in route as untested rather than
dead.

**Still open pending a successful create:** payment identifier length (expected
fit) and whether the create response carries the recipient wallet address. The
probe failed before an identifier existed, so it answered neither.

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

   **Fee floor — a hard constraint on that primitive.** The first live send paid
   **100,000 stroops (0.01 Pi) in fees to move 0.0000001 Pi**: a 100,000×
   overhead. The fee is per-transaction and flat, set by the network via
   `fetchBaseFee()` rather than chosen by us, and it can rise under congestion —
   0.01 Pi is an observed floor, not a ceiling.

   What that rules out. A per-transaction A2U payment is only rational when the
   amount is large relative to 0.01 Pi: at 1 Pi the fee is 1%, at 10 Pi it is
   0.1%, and below roughly 0.1 Pi the fee starts to dominate the transfer.
   **Dust-sized agent micropayments do not work on-chain**, which matters
   because "agent pays a fraction of a cent per task" is exactly the shape the
   agent-economy designs this project exists to explore would naturally reach
   for.

   What that implies for design. Anything settling sub-0.01-Pi exchanges needs
   **aggregation above the fee floor** rather than one transaction per event:
   an off-chain credit ledger settled periodically, batched payouts per
   recipient, or a threshold that withholds payment until the accumulated
   balance makes a transaction worth its fee. A task board that pays per task
   must either price tasks well above the floor or batch settlement — those are
   the only two options, and the choice belongs in the design rather than being
   discovered after the first thousand dust payments.

   Unverified: whether mainnet fees differ, and whether Pi offers any
   fee-bumping or channel mechanism. Both are on `pre-mainnet.md`'s territory if
   A2U ever leaves testnet.
3. Open questions — still unanswered after the Tier A/B/C build:
   - ~~Mainnet Horizon URL + network passphrase~~ **answered 2026-08-14 (v0.4)**:
     `https://api.mainnet.minepi.com`, passphrase `Pi Network` — not the
     "Pi Mainnet" the pattern predicts. See pi-sdk-notes.md, Layer 3.
   - Whether GET /payments requires the payment to belong to our app (Tier C).
     Half-answered 2026-07-31: it definitely *works* for a payment that does
     belong to us. Whether a foreign payment id is refused is still untested,
     and that is the half that matters for security.
   - A2U end-to-end latency and failure modes (incomplete payment recovery) (Tier C)
   - **Does a Pi Sign-in `wallet_address` consent satisfy A2U create?**
     **Untested in both directions** — we have never confirmed that it does, and
     we have never cleanly demonstrated that it does not. The one experiment
     touching this is confounded (above). What *is* verified is the Browser SDK
     route, so that is what our remediation text recommends; it recommends the
     known-good path without asserting the other is dead.

     This question decides the reach of the "agent pays human" primitive. If
     Sign-in consent works, A2U can pay anyone who has completed an OAuth flow
     anywhere. If it does not, A2U is limited to users onboarded through the Pi
     Browser — materially narrower than the docs imply. Worth an experiment of
     its own rather than inference from adjacent failures.

## Resolved

- **Payment identifier length — 28 bytes, fits exactly** (confirmed 2026-07-31
  by `npm run probe:a2u` against a live A2U create; `tG76m134ce43WkPasVL8nCWLUomS`).
  Three samples across both directions — two U2A, one A2U — are all exactly 28
  characters of base62-style ASCII, so the format is stable and shared. This
  lands precisely on the Stellar `memo_text` cap, which reads as deliberate:
  Pi appears to have sized payment ids to fit a memo. The earlier worry that ids
  would follow the 36-character UUID convention Pi uses for uids was wrong.

  The fit is exact, with **zero headroom**, which makes two details in
  `send_payment` load-bearing rather than incidental: it writes the bare
  identifier (`Memo.text(payment.identifier)`) and decorates it with nothing —
  any prefix or tag would overflow — and its guard is `> MAX_MEMO_BYTES`, not
  `>=`, so a 28-byte id passes. An off-by-one there would reject every payment.
  Neither should be "tidied".

- **The create response *does* carry the recipient wallet — as `to_address`,
  not `recipient`** (2026-07-31). No separate lookup is needed, so the original
  design assumption held; only the field name was wrong.

  `probe-a2u.mjs` reported this as "✗ Missing or malformed — send_payment needs
  a separate lookup step", which was wrong for the same reason the tool was: it
  read `payment.recipient`, a field the API does not return. The live response
  clearly carries `to_address`, plus `from_address` for the app wallet. **The
  probe's own verdict on this question should not be trusted; read the response
  body it prints above the verdict.**

  This was a real bug in `send_payment`, not just in the probe: `PiPayment`
  declared `recipient`, and the response is *cast* to that interface rather than
  parsed, so the wrong name was `undefined` at runtime and invisible to
  TypeScript. Every A2U payment would have failed while building the
  transaction — safely, at the `submit` stage with no funds moved, but leaving a
  stranded payment record every time. Fixed, with a pre-signing address check
  alongside the memo check so a future rename fails cleanly instead of mid-build.

  General lesson: casting an external response to an interface buys no
  guarantees. Every field name in that interface is an untested assumption until
  something reads it against real data.

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
  **Observed live 2026-08-01:** a routine `npm run smoke` happened to draw an
  account whose three most recent records were all `invoke_host_function`, and
  `get_account_payments` returned them typed, with no asset fields invented.
  The gotcha was originally recorded from reading the feed during the Tier A
  build; this is the first time it appeared unprompted in the wild, with the
  tool handling it as designed.
- Horizon always emits a `_links.next` cursor, even past the end of a result
  set, so its presence is not a "more results" signal.
- `GET /v2/me` returns **401 with an empty body** — no JSON error document.
  Error handling that assumes a parseable body will throw on the most common
  failure case.
- Accounts hold `liquidity_pool_shares` balances keyed by `liquidity_pool_id`
  rather than a code/issuer pair.
- Pi uids are 36-character UUIDs, not opaque short ids. Relevant because the
  A2U memo budget is 28 bytes.
- **One confounded observation involving Pi Sign-in — draws no conclusion.**
  With a valid server API key, an attached app wallet, and a fresh Sign-in token
  whose `/v2/me` listed `wallet_address` among granted scopes, A2U create still
  failed with `missing_scope` for that uid.

  This was previously written up here as evidence that a Sign-in grant does not
  satisfy A2U. **That conclusion is withdrawn** (2026-07-31) — the experiment
  cannot support it. At least two explanations remain live and the data does not
  separate them: either the two surfaces keep different grant records, or the
  OAuth client and the server API key belong to different apps, in which case
  that uid was meaningless to the paying app and the result says nothing about
  Sign-in at all. The decisive check is cheap and still unrun: compare the uid
  from that experiment against a Browser-SDK uid for the same human and the same
  app. Same uid implicates the grant records; different uid implicates the app
  configuration.

  Recorded because the data exists, not because it establishes anything. See the
  open question below.
- **A2U requires the recipient to have granted the `wallet_address` scope.**
  Undocumented in the A2U guide, and it is the recipient's consent that is
  missing, not the app's. `POST /v2/payments` returns `401 missing_scope` —
  a status that otherwise means "bad API key", so the body must be read to
  tell a consent problem from a credential problem. Sending Pi to a user
  therefore requires them to have signed in and approved wallet_address first;
  a uid alone is not sufficient. **Reconfirmed 2026-07-31** against a
  Browser-SDK-authenticated uid — see the `send_payment` constraint section
  above for the tool-level requirement this creates.
- `/v2/me` returns an `app_id` and a `receiving_email` flag that the platform
  docs do not mention.
- **A U2A payment identifier is 28 characters of base62-style ASCII** — e.g.
  `WmVLw2vEdNLe9GfbH8stVT0oW5YL`, measured across two live runs (2026-07-31).
  Exactly 28 bytes, exactly the Stellar `memo_text` cap. See the memo entry
  under open questions for what that implies for `send_payment`.
- **An undocumented `platform` scope comes back on every grant.** Requesting
  only `payments` through the Browser SDK returned `payments, platform`; Pi
  Sign-in independently returned `platform` with `username`. Two auth surfaces,
  same extra scope, no documentation. Recorded in `pi-sdk-notes.md`. Code that
  diffs granted scopes against requested ones must tolerate extras.
- **First live U2A payment** (2026-07-31), kept as a fixture for validating the
  read tools against real data: txid
  `911c3f802a8d1d762d23a1286700aeb1250c86355b43647a59016dc25d86a4f2`, 0.314
  Test-Pi. Public chain data, so it is safe to record here; the recipient uid
  from the same run is deliberately **not** recorded — see below.
- **App-scoped uids stay out of this repo.** A uid is anti-correlation-designed
  across apps, but within this app it identifies a real person, and this
  repository is public. Keep uids in local env or notes, not in committed docs.

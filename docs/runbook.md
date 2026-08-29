# Pion Runbook

Operational notes for the parts of Pion that touch live Pi infrastructure —
what to capture when something fails, and how to read what comes back.

Design rationale lives in `pi-sdk-notes.md` and `tool-mapping.md`. This file is
for the moment something is broken and you want the answer, not the reasoning.

---

## U2A payment test — `site/pay.html`

The user-to-app round trip: the Pi Browser initiates a payment, our two Netlify
functions approve and complete it. Used to satisfy the Developer Portal
checklist, and as the live smoke test for the Tier C U2A backend.

**Live-verified 2026-07-31** — a real 0.314 Test-Pi payment completed end to end
against the production Platform API.

### Running it

Open `https://pionmcp.com/pay.html` in the **Pi Browser on a phone**. No query
string: sandbox defaults off, which is what the real Pi Browser needs. Add
`?sandbox=1` only for the desktop portal harness.

Sandbox is not the Mainnet/Testnet switch — see the `sandbox` entry in
`pi-sdk-notes.md`. The network is fixed at app registration, so a
testnet-registered app moves Test-Pi with the flag either way.

Do not test from a Netlify **deploy preview or branch deploy**.
`PI_SERVER_API_KEY` is scoped to the production context, so both functions
return `503 not_configured` anywhere else. That is correct behaviour, not a bug,
but it looks like a broken deploy if you forget.

### What to capture when it fails

A screenshot of the whole page after it stops gets most of it: the mode line,
the uid card, the verdict banner, and the flow log are all on one screen by
design. The screenshot is safe to share — the access token is deliberately never
rendered, and the server API key never leaves the server.

Two things worth copying as text rather than trusting to a screenshot:

- **`paymentId`** — logged by `onReadyForServerApproval`. Without it a stuck
  payment cannot be inspected, completed, or cancelled server-side later.
- **`txid`** — logged by `onReadyForServerCompletion`. Matters most when
  *completion* is what failed, because it means the transaction may have landed
  on-chain while Pi's record still says incomplete. It is checkable against
  Horizon, which is exactly what Pion's own `query_transaction` does.

Also note **which callback fired last** — that alone localizes the failure — and
the **JSON block** rendered under any failure line, which carries `stage`,
`upstreamStatus`, and for a refusal the `problems` array.

### Reading the failure

| What you see | What it means |
|---|---|
| No log line after `createPayment` | Never reached the server phase. Nothing in our functions is implicated — look at scopes or the SDK. |
| `409 unexpected_payment` | The pre-approval check refused. `problems` names the exact field that did not match, so this is the most informative failure available: it means the SDK created a payment differing from what the page asked for (amount coerced, memo altered). |
| `502` with `upstreamStatus` 401 or 403 | Our key was rejected. Most likely the key belongs to the *other* Developer Portal app — Mainnet and Testnet require separate apps, each with its own key. |
| `404` at `stage: "lookup"` | Same wrong-app symptom from the other direction: the payment is not visible to the app this key belongs to. |
| `502` with `upstreamStatus: null` | Network-level: Pi unreachable or past the 15s timeout. Nothing was decided; the payment state is unchanged. |
| `400` at `stage: "complete"` | Pi rejected the txid. The transaction may still exist on-chain — keep the txid. |
| `missing_txid` from the complete function | The payment never reached the chain. It cannot be completed and must be cancelled instead. |

The status split is deliberate: **502 means the failure is ours** (network, Pi
5xx, or a rejected key), while a passed-through 400/404 means the failure is
about the payment itself. If you are triaging, that distinction tells you
whether to look at configuration or at the payment.

### Recovering a stuck payment

If the flow stalls after approval, **do not re-tap Pay**. That creates a second
payment and leaves the first one stuck.

The stuck payment resurfaces through `onIncompletePaymentFound` on the next
`Pi.authenticate`, which is already wired to the complete function — so
re-authenticating on the page is the normal recovery path. An incomplete payment
also blocks authentication until it is resolved, so this is not optional.

If it has a `txid`, it can be completed. If it has none, it was never submitted
on-chain and must be cancelled (`POST /v2/payments/{id}/cancel`) rather than
completed.

### Where the logs are

The browser only sees what our functions chose to return. When the page shows a
bare 502, a non-JSON response, or nothing useful, the **Netlify function log**
for `approve` / `complete` has the server-side detail — including the upstream
body text that `upstreamFailure` truncates to 300 characters.

Nothing in those functions logs the API key, and the fetch error is reported by
message only, because a raw fetch error object can echo the request headers.

---

## A2U send — pre-flight gates

Both must be green before `PION_ENABLE_PAYMENTS=1`. Neither costs anything and
both catch failures that are expensive after a payment record exists.

### Gate 1 — nothing lingering

```powershell
$s = Read-Host "Server API key" -AsSecureString
$env:PI_SERVER_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
npm run incomplete
```

Expect `✓ No incomplete server payments`. Asks Pi directly rather than trusting
that an earlier cancel returned 200. A lingering record means a retry creates a
second payment for the same intent.

### Gate 2 — the right wallet, funded

**A2U spends from the APP wallet** — the one attached to your app in the
Developer Portal — **not your personal Pi Browser wallet.** These are different
accounts, both yours, both funded, and only one of them works. Signing with the
wrong key produces a transaction Pi cannot match to the payment record.

Getting the secret: the Tokens guide states *"You can access your wallet's
private key from the wallet's settings page"* — that is the Pi Wallet at
`wallet.pi` in the Pi Browser. Path: **Pi Browser → wallet.pi → switch to the
app wallet on testnet → settings → private key.** Switching to the app wallet is
the step that is easy to skip, and skipping it silently gives you the personal
wallet's key.

If the switcher shows only your personal wallet, look in the **Developer
Portal's App Wallet section** — that is where the wallet was connected to the
app, so it is the right next place. Be prepared for it to show the address
without re-revealing the key: many systems disclose a secret only at creation.
If so, the key is in whatever you saved when the wallet was created, and
failing that the recovery path is creating a new app wallet, re-connecting it
in the portal, and re-funding it. *(Both portal behaviours unverified — reported
as where to look, not as what you will find.)*

```powershell
# Read-Host ECHOES what you paste — the secret lands in the terminal buffer.
# -AsSecureString masks it; the marshalling is how PS 5.1 gets plaintext back.
$s = Read-Host "Wallet secret" -AsSecureString
$env:PI_WALLET_SECRET =
  [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
$env:PI_WALLET_SECRET.Length                        # expect 56
npm run wallet GATQBZLIAUVMND2OCPOKWGPUCNXIGKMNUU7E67YQI2MODSMCMLXBAIJA
```

**Current app wallet: `GATQBZLIAUVMND2OCPOKWGPUCNXIGKMNUU7E67YQI2MODSMCMLXBAIJA`**
(third wallet, 2026-07-31; the two before it are retired — see `pi-sdk-notes.md`).

That check proves the secret matches the address you typed. It does **not**
prove Pi agrees this is the app wallet — for that, the address has to come from
Pi rather than from you.

### Gate 2b — Pi's own answer (never skip this)

```
npm run probe:a2u <your-uid>
```

Confirm `from_address` on the create response is the wallet above. The probe
cancels its own record, so it costs nothing.

**This is not a formality.** Creating an app wallet in the Portal does not
select it, and only the selected wallet is spent from. On 2026-08-01 a newly
created wallet sat unselected while Pi kept using the old one — see
`pi-sdk-notes.md`. `from_address` is the only place the selection is
observable.

If it names a different wallet, **do not arm** — signing with a wallet Pi is
not expecting moves funds `/complete` cannot verify. Go and *select* the right
wallet in the Portal, then re-run this gate; the change is visible within
seconds, and the probe is free and self-cleaning.

Session-scoped in your terminal only. Never in Netlify, never in a file, never
committed. The secret is never printed by any script here; the derived public
key is public by definition.

Plain `Read-Host` keeps a secret out of *history* but not off the *screen* — it
echoes as you paste, so the value stays in scrollback, in any terminal logging,
and in a screenshot. Use the masked form above for wallet secrets and API keys
alike.

**Always pass the expected address.** Without it the script can only report
"derived and funded", which is exactly what it reported on 2026-07-31 for a
personal-wallet secret — right shape, real account, 99 Pi in it, and completely
wrong. The app wallet's address is the `from_address` on any A2U create
response, which `npm run probe:a2u` prints.

If the derived address does not match, you have the wrong wallet. Go back and
switch wallets in `wallet.pi` before exporting again.

---

## Principle: hidden by incidental coverage

**An assumption exercised a hundred times is not thereby tested, if the test
data happens to satisfy it.**

The sharpest general finding of this build. Two instances, both in the A2U path,
both invisible until something ran with different inputs:

- **`metadata` must be non-empty.** `probe-a2u.mjs` always sent
  `{ probe: true }`. Every probe passed. The requirement was undocumented and
  unmet by `send_payment`, which sent `{}` — and the first call that omitted
  metadata failed at create.
- **The recipient field is `to_address`, not `recipient`.** Every probe printed
  a full response body containing `to_address` in plain sight, while the code
  read a field that did not exist. Repetition did not help; nothing ever
  compared the two.

What both have in common: the thing repeated was *the same call with the same
shape*. Repetition explores no new state, so a hundred runs test exactly what
one run tests. What actually found them was **a first call from a different
caller** — a real send rather than the probe.

Practical consequences for this repo:

- Treat "we have run this many times" as evidence about *one* input, not about
  the API.
- A probe that constructs its own request is testing its own request. Fixtures
  in `arming-test` come from real captured responses precisely so they can
  disagree with what the code expects.
- When a field is optional in our schema but never omitted in practice, that is
  the untested path. Omit it deliberately once.
- The most informative call is the first one made by new code, not the
  hundredth by old code.

## Principle: describe capabilities by tier, not by version

**Prose should say which tier a capability belongs to, never which version
introduced it.** A version-dated description goes stale silently: nothing
recompiles it, no suite asserts it, and it keeps reading as true long after it
stopped being true.

`site/index.html` told visitors "v0.1 talks only to public endpoints" through
four minors and the entire arrival of Tier C — a payment path that does take
keys. Nobody wrote anything false; the sentence was accurate when written and
was never revisited, which is the whole failure mode. Describing the same thing
by tier — the read tools need no configuration, payments are optional and off by
default — stays true as versions land, because it describes the shape of the
thing rather than a moment in its history.

The inverse holds, and matters as much: history *should* be dated. The 0.4.x
references throughout this file, and in the README's `Requirements` section, are
correct precisely because they are claims about what happened rather than about
what is. Date the postmortem, not the description.

## Secret exposure policy

Decide by **what leaked**, **where it went**, and **which network it controls**
— not by how bad it feels. The mainnet answers are written down here so they do
not have to be improvised under pressure.

### Rotate immediately, assume compromised

- Anything that controls **mainnet** value, on any exposure at all.
- Anything **committed to git**, even if the commit was amended or the branch
  force-pushed. Once pushed, treat it as public: forks, clones, CI caches, and
  provider mirrors keep copies you cannot reach.
- Anything **sent to a third party** — pasted into a web tool, an LLM, a chat, a
  screenshot, or an issue tracker. Deletion does not undo indexing or caching.
- Anything placed in a **hosting provider's env** that did not need it. The
  wallet secret must never be in Netlify: nothing served from the site signs
  transactions, so its presence there is pure exposure.

### Record, do not rotate

Testnet-only credentials exposed **locally and only locally** — shown on your
own screen, held in your own shell, read by a script that never printed it.
Test-Pi has no market value, and rotating a wallet is not a password reset:
there is no "change the seed" operation, so it means creating a new wallet,
re-connecting it, re-funding it, and re-verifying. That cost is not worth
paying for test funds.

Note the event and move on — but only after answering the question below.

### The question that decides which bucket you are in

**Does the exposed testnet key share a derivation with a mainnet key?**

If the Pi Wallet's testnet and mainnet wallets come from the same passphrase,
then a "testnet-only" seed exposure is a *mainnet* exposure wearing a disguise,
and the first bucket applies. If they are independently derived, the second
bucket does.

**This is unverified for Pi and must be answered before relying on the second
bucket.** Until it is, treat a personal-wallet seed exposure as
rotate-if-convenient rather than confidently safe.

### EMERGENCY — the app wallet's key is compromised

**On mainnet this is an incident, not a task.** The compromised key is the
app's live spending account: an attacker holding it can sign transactions from
the same wallet you are trying to protect, and you cannot revoke a Stellar seed.
You are racing someone with identical authority over the funds.

The measured fact that shapes the response: **creating a replacement wallet
does not switch anything — selecting it does, and selection takes effect within
seconds.** Verified 2026-08-01: a new wallet left unselected meant Pi kept
spending from the old one indefinitely; once selected by hand, a probe under 30
seconds later already showed the change.

So the exposure window is not a delay you wait out. It is exactly as long as it
takes you to perform the selection step — which means the single highest-value
action is knowing that the step exists.

1. **Create the new wallet and SELECT it, immediately, before anything else.**
   Creation alone changes nothing; an unselected new wallet leaves the
   compromised one spending. This is the step that stops the bleeding and it
   takes seconds.
2. **Disarm payments** — unset `PION_ENABLE_PAYMENTS`. Your loaded
   `PI_WALLET_SECRET` is now the *old* wallet's while Pi expects the new one, so
   `send_payment` would move funds Pi cannot verify. Refusing to send beats
   signing into a mismatch.
3. **Move the funds out** of the compromised wallet to an address you control.
   You and the attacker hold identical authority; whoever signs first wins.
4. **Confirm with `npm run probe:a2u <uid>`** — read only `from_address`. This
   is the only place the selection is observable.
5. **Re-arm only after** `from_address` matches *and* `npm run wallet <address>`
   confirms the newly loaded secret derives to that same wallet.

The old wallet cannot be deleted — see `pi-sdk-notes.md`. It stays in the
selector permanently, so a compromised wallet remains one mis-click from being
live again. Draining it in step 3 is what makes that mis-click harmless.

On testnet, all of this is a rehearsal — the balance is worthless, so the
correct move is to run the procedure anyway and time it.

### Clearing a leaked secret from a Windows shell

Overwriting the env var is not enough — the value persists in history and
scrollback:

```powershell
Clear-History                                          # this session
Remove-Item (Get-PSReadlineOption).HistorySavePath     # the persistent file
$env:PI_WALLET_SECRET = $null
```

Then close the terminal to drop the scrollback buffer. None of this reaches a
value that already left the machine.

### Drills

Deliberately exposing a worthless testnet credential to test this policy is
encouraged, not a violation of it. It is the only way to measure a blast radius
rather than guess at one, and every control in this file that exists because of
a drill is a control that did not have to be paid for with a real key.

Record a drill as a drill. The distinction matters when someone reads this
later: an accident says people need reminding, a drill says the system needed a
check — and the second one is actionable.

### Recorded events

- **2026-08-01 — stranded-payment drill (A: submit stage, B: complete stage).
  Deliberate; found a defect that would have lost funds.**

  Both untested branches of `strandedReport` were induced on testnet. **A**
  armed with a freshly generated, never-funded seed, so create succeeded and
  `loadAccount` 404'd — a record with no transaction, structurally incapable of
  spending. **B** routed `PION_PLATFORM_URL` through a local proxy that answered
  `POST /complete` with 503 and never forwarded it, so the transfer landed
  on-chain while Pi was genuinely never told. Neither drill modified Pion; the
  faults were injected outside it, so the shipped code path ran untouched.

  Both reports were accurate about the funds position, carried the identifiers
  needed to recover, and leaked no credential. Both strands appeared in
  `incomplete_server_payments` immediately — **the first evidence that gate 1
  can detect anything at all**, since every prior run had returned empty. Both
  recovered cleanly (A cancelled, B completed with its txid) and the list
  returned to empty, so drills leave no permanent artifact.

  **The finding: Pi's record cannot distinguish "never submitted" from
  "submitted but unreported."** Both drills produced `transaction: null` and
  `transaction_verified: false` — byte-identical states, one safe to cancel and
  one where the recipient had already been paid. Pi learns a txid only when
  `/complete` succeeds, so a payment it was never told about looks exactly like
  one that never happened. Two things followed that guidance to the wrong
  conclusion: `incomplete.mjs` printed *"one without a transaction was never
  submitted and should be cancelled"*, and `cancel.mjs` guarded on
  `payment.transaction?.txid` — a field that is null in precisely the dangerous
  case. Following either would have converted a recoverable strand into a
  silent loss.

  Fixed by asking the chain instead. The payment identifier rides on-chain as
  the Stellar text memo, so `cancel` now searches the sending wallet's
  transactions for that memo and refuses if it finds one. It also refuses on a
  record younger than five minutes (Horizon ingestion lag could otherwise report
  a false "nothing on-chain") and on any inconclusive search, because an
  unnecessary refusal leaves a record listed while a wrong cancel loses money.
  Verified against both drill records: B's is found, A's is not.

- **2026-07-31 — argv exposure drill. Deliberate; produced a control.**
  A testnet app wallet seed was intentionally pasted onto a `probe:a2u` command
  line, concatenated onto the uid, to exercise the failure mode while the stakes
  were zero. Chosen deliberately: a worthless key on testnet is the cheapest
  possible way to learn what an argv leak actually touches, and the alternative
  is discovering it with a key that matters.

  **Blast radius, measured rather than assumed.** One mis-paste put the seed in
  PowerShell history (including the persistent PSReadLine file), the terminal
  scrollback, the working transcript, and **Pi's own server logs** — the script
  posted it as the `uid` field of a create request before anything could object.
  That last one is the finding: a leaked argument does not stay local, and by
  the time the request returns, remediation is out of your hands.

  **Control built:** `scripts/guard-argv.mjs`, wired into every script that takes
  arguments, refusing before any network call. "Credentials go in the
  environment, never in an argument" had been a convention documented in
  comments — including in the usage text printed directly above where the seed
  went in. The drill's actual lesson is that a convention depending on nobody
  mis-pasting is not a control, and the fix is mechanical enforcement rather
  than a better-worded warning.

  The drilled key stays retired: it is real in the sense that anyone reading the
  transcript can sweep its balance, and a drained wallet would surface later as
  a confusing submit-stage failure.

- **2026-07-31 — personal testnet wallet seed, local only.** Exported while
  reaching for the app wallet secret, entered via echoing `Read-Host` (so it
  reached the terminal buffer), read by `npm run wallet`, never printed, never
  written to disk, never committed, never transmitted. Bucket 2 *conditional on
  the derivation question above*. Env var overwritten in-session. No app wallet
  or server key was involved.

### Arming validates the money network, deliberately not the Platform API

`checkPaymentsArming` refuses any `PION_HORIZON_URL` without `testnet` in it.
It does **not** validate `PION_PLATFORM_URL`, which can point anywhere while
payments are armed.

That asymmetry is a decision, not an oversight. Horizon is where irreversible
value moves, and Pi restricts A2U to testnet, so the guard enforces the
platform's own restriction at the only place a mistake spends real money. The
Platform API is coordination and bookkeeping — redirecting it cannot by itself
move funds, because funds move through a signed Stellar transaction the
Platform API never touches.

Stated adversarially: anyone with environment control can redirect the Platform
API while armed. That is not an escalation. Environment control is already
total control — the same person sets `PI_WALLET_SECRET` and could simply sign
whatever they like. A guard there would stop nothing and imply a boundary that
does not exist.

The practical upside is that fault injection at the Platform API needs no code
changes, which is what makes the stranded-payment drill possible: a local
pass-through proxy breaks one route while the shipped code path runs untouched.

### If a send fails anyway

`send_payment` reports which step it reached, and that determines what to do:

| Step | What happened | Action |
|---|---|---|
| `create` | No record, no funds moved | Safe to retry |
| `submit` | Record created, nothing signed | `npm run cancel <id>` before retrying — never retry blind, it creates a second payment for the same intent. Cancel only via that script: it checks the chain first, and Pi's record alone cannot tell this case from the one below |
| `complete` | **Funds have left the wallet**, Pi not notified | Do NOT retry. Complete manually via `POST /v2/payments/{id}/complete` with the txid |

A `submit`-stage failure with no payment id in the message means the response
could not be parsed; find the record with `npm run incomplete`.

### Verifying the code without a live payment

`npm run u2a` exercises both functions against a local stub — the refusal paths,
the id validation, the status mapping, and the rule that completion is reported
only on a 200. No real API contact, fake key. Run it before deploying a change
to either function.

`npm run signing` covers the other half: it rebuilds the exact transaction
`send_payment` signs, with every input pinned, and compares the envelope and
transaction hash against bytes recorded in the file. Offline, no credentials,
cannot spend.

It exists because the suites above all stub the network, so none of them can
answer "did an SDK upgrade change what we put on the wire?". Diffing the signed
XDR across 16.2.0 and 17.0.0 is what actually cleared that bump — identical
envelope, identical hash — and the script is that diff kept as a standing check.
Run it on any `@stellar/stellar-sdk` change. A failure means the bytes moved for
identical inputs; find out which field before touching the constants.

---

## Mainnet reads — the v0.4 validation gate

Mainnet reads shipped only after the same discipline the send drills used: the
tool's own report is not evidence, and three independent sources had to agree.

Run `npm run smoke:mainnet` and `npm run crossnet` after any change touching
`src/networks.ts`, `src/horizon.ts`, or the arming check.

### What was verified, 2026-08-14

**Network identity, from primary sources rather than the naming pattern.** Each
Horizon node reports its own `network_passphrase`; Pi's production explorer
bundle carries the mainnet URL as build config. Mainnet is
`https://api.mainnet.minepi.com`, passphrase **`Pi Network`**. The pattern-guess
`Pi Mainnet` is wrong and appears in Pi's own explorer as UI copy, which is the
kind of false corroboration worth naming out loud. Details and the third check
in `pi-sdk-notes.md`, Layer 3.

**A mainnet read, agreeing three ways.** Account
`GCZYTVXS2K7DY3LJ6F3P5CVH3OU4ZGUKAXAUTE3K7NZGNH55ONISQCMB`, discovered from the
live ledger rather than hand-picked:

| | via `get_wallet_balance` | via raw Horizon |
|---|---|---|
| balance | `2.0600000` PI | `2.0600000` |
| sequence | `107166829968883735` | `107166829968883735` |
| last_modified_ledger | `28210699` | `28210699` |

And an immutable transaction, `f8b6d6c83dfb32452330b677d901748fb6cece6c36d9b2deff64bead6e1c6925`
at ledger 28210699 — `successful: true`, `fee_charged: 100000`, memo_type `text`,
memo `PML-Trq5irLcr0dsUap1N6gwZCZz` — identical through both paths.

**Third source — human eyes on the explorer. Done 2026-08-14; gate closed.**
Field *values* must be compared, not merely that a page renders: the explorer is
a client-side app that returns HTTP 200 for everything, including nonsense, so a
status check proves nothing.

```
https://blockexplorer.minepi.com/mainnet/tx/f8b6d6c83dfb32452330b677d901748fb6cece6c36d9b2deff64bead6e1c6925
https://blockexplorer.minepi.com/mainnet/account/GCZYTVXS2K7DY3LJ6F3P5CVH3OU4ZGUKAXAUTE3K7NZGNH55ONISQCMB
```

The transaction is the better anchor of the two — it is immutable, where the
balance drifts. Confirmed by eye against the transaction page: **fee 0.01 π,
ledger 28210699, memo `PML-Trq5irLcr0dsUap1N6gwZCZz`** — all three matching the
tool report and raw Horizon exactly. Three independent sources agree.

*One nuance recorded so the next reader does not over-read this entry.* The
explorer page renders the transaction's `create_claimable_balance` operation
rather than an error state, which is consistent with success but is not by
itself proof of it — Stellar explorers list the operations of failed
transactions too, marking the failure elsewhere on the page. `successful: true`
is attested by the tool report and raw Horizon, which agree; the explorer's
contribution to this gate is the three field values above. That is enough, and
saying which source proved which is the point of keeping the record.

**Arming, under the worst configuration available.** With every payment
credential present and correct and `PION_NETWORK=mainnet`: the server starts,
serves all three read tools, and does not advertise `send_payment` at all.
Covered permanently by `npm run arming`.

### The assumption that turned out to be false

The first version of `crossnet` asserted that an account funded on one chain is
absent from the other. It is not. The same address held **2.0600000 Pi on
mainnet and 32.2993800 Pi on testnet at the same moment**, with different
sequence numbers; across six sampled mainnet accounts, three also existed on
testnet.

The consequence is the reason the network is stamped on every result rather than
announced once at startup: **a read against the wrong chain does not reliably
fail.** It can return a well-formed, plausible, wrong number — the same shape of
silent wrong answer as `FINDINGS.md` §4. `crossnet` was rewritten to assert what
actually holds: a wallet we control is testnet-only, and a shared address must
return *different* ledger state from each chain.

---

## Dependency bumps — the floor you inherit

**A dependency's `engines` field silently becomes your floor. Nothing checks
that your own field still tells the truth.**

Found during the `@stellar/stellar-sdk` 16 -> 17 review (2026-08-28), by reading
the installed dependency's metadata by hand. It had been wrong for two releases
before anyone looked.

`package.json` declared `"node": ">=18.17"` through 0.4.0, 0.4.1 and 0.4.2. The
`@stellar/stellar-sdk` 16.x pinned across all three declared `">=22.0.0"` of its
own. The real floor was 22.0.0 from the moment v16 landed, and we advertised
18.17 to every consumer for three releases.

Why nothing caught it:

- **npm checks the installing package's field, not the tree's.** A consumer on
  Node 18 installing pion-mcp is checked against *our* `>=18.17` and passes. The
  transitive `>=22.0.0` produces an `EBADENGINE` warning at most, and warnings
  scroll past. No error, no failed install, nothing to notice.
- **Every suite and every local run was on Node 22+.** The floor we published
  was never the floor anything was tested against, so no test could fail on it.
  That is the incidental-coverage principle above, pointed at the environment
  rather than at the data.
- **The dependency's own bump looked routine.** v16 arrived in a Dependabot PR
  like any other. An `engines` change lives in the dependency's metadata, not in
  the diff the PR shows you — reviewing that PR could not have surfaced it.

The general shape: `engines` is a promise about the whole installed tree, but it
is written by hand about one package, and nothing reconciles the two. It only
ever drifts in one direction — dependencies raise their floors, they do not
lower them — so the error is always "we promised support we cannot deliver",
never the reverse. That is the direction that reaches consumers.

Corollary for the payment path specifically: the SDK is imported lazily inside
the `send_payment` handler, so an inherited floor being wrong breaks neither
startup nor the read tools. It breaks exactly one thing, and it is the thing
that moves money.

The gate this produced is in the release procedure below. It costs one command.

## Release procedure

Verified through the 0.4.0 and 0.4.1 publishes. Every rule below was learned by
breaking it in one of those releases, not by foresight.

### Reconcile the declared engines floor against the tree

**Standing gate on any release whose dependencies moved.** Our `engines.node`
must be at least as high as every dependency's, and nothing enforces that
automatically — see "Dependency bumps — the floor you inherit" above for how it
went wrong for three releases.

One command, run after `npm ci` and before the version bump:

```
node -e "const fs=require('fs'),p=require('./package.json');console.log('  '+'pion-mcp (declared)'.padEnd(32),p.engines?.node??'(none)');for(const d of Object.keys(p.dependencies??{})){let e;try{e=JSON.parse(fs.readFileSync('./node_modules/'+d+'/package.json','utf8')).engines?.node??'(none)'}catch{e='(not installed)'}console.log('  '+d.padEnd(32),e)}"
```

Read it as one rule: **the first line must not be lower than any line below
it.** At 0.5.0 it reads

```
  pion-mcp (declared)              >=22.12.0
  @modelcontextprotocol/sdk        >=18
  @stellar/stellar-sdk             >=22.12.0
  zod                              (none)
```

which is correct — we are level with the highest floor we inherit. The same
command at 0.4.2 would have shown `>=18.17` above a `>=22.0.0`, which is the
failure: a floor we could not honour.

**`devDependencies` are deliberately out of scope, and the omission is load
bearing — do not "fix" it.** The gate answers one question: what must a
*consumer* be running. Consumers never install our devDependencies. `files` is
`["dist"]`, so the published tarball is build output plus `package.json`, and
npm installs only `dependencies` from it. A devDependency's floor therefore
cannot constrain anyone downstream.

Folding them in would not merely add noise, it would invert the gate. TypeScript
raising its floor to Node 24 would make this check demand we publish `>=24`,
narrowing what consumers may install to satisfy a compiler they never receive —
the same false promise as 0.4.2, aimed the other way. The gate would be arguing
for a lie it was written to catch.

devDependency floors do still matter; they just answer a different question,
about the machine that builds and tests. If one outgrows the environment, that
is a CI and contributor-setup problem, and it belongs wherever that is tracked
— not in the number we publish.

Raising our own floor narrows what consumers can install, so it is a breaking
change and forces at least a minor. Take that cost when it appears rather than
carrying a false promise — a floor that is quietly wrong is not cheaper, it is
just deferred onto whoever installs on the runtime we claimed to support.

### Gates must be pasted one at a time

**A gate inside a pasted block is decoration.** In the 0.4.0 release the whole
gated checklist went into the terminal as a single block. `npm whoami` failed —
not logged in — and the sequence carried on regardless: every later gate ran,
and `git push origin v0.4.0` completed *before* `npm publish` had succeeded.
The tag briefly pointed at a version that did not exist on the registry.

The recovery was clean only by luck: `npm login` then `npm publish` landed on
the same commit the tag already named, so the tag ended up correct. Had the
publish needed a code change, the pushed tag would have been wrong and would
have needed a force-update — the one operation on a published tag that breaks
anyone who already fetched it.

So: **one paste per gate, read the output, then paste the next.** A shell does
not stop a `;`-joined or newline-pasted sequence when one command fails, which
means a checklist's ordering guarantees exist only if a human enforces them
between pastes. This is the same principle as the send drills — a check whose
failure does not halt the next irreversible step is not a check.

Corollary: `git push <tag>` is a gate of its own and belongs strictly *after*
publish returns success. Creating the tag locally beforehand is fine; pushing
it is the irreversible half.

### The version bump includes the lockfile

`package-lock.json` carries the version twice, at `.version` and
`.packages."".version`. Editing `package.json` alone leaves it stale, and
nothing in the build, the test suites, or `npm pack` notices — the lockfile is
not published (`files: ["dist"]`), so the tarball is correct either way and the
discrepancy survives into the repo.

In 0.4.0 it was caught only because an incidental `npm install` synced it and
left an unexplained modified file in the tree afterwards. Bump both together, or
run `npm install --package-lock-only` right after editing the version so the
lockfile moves in the same commit.

### The browser handshake is not the success signal

With 2FA on the account, `npm publish` prints an auth URL and **blocks waiting
for approval**. The approval is not the publish: the tarball uploads only after
the still-running process receives the token back. So the command has to be
alive when you approve, and a publish that has already exited cannot be
completed by approving its link afterwards.

In 0.4.1 a first `npm publish` exited on `EOTP` before the link was opened.
Approving it later published nothing — while the browser reported success,
which is the wrong reassurance at the worst moment. The only success signal is
the terminal line:

```
+ pion-mcp@0.4.1
```

Not the browser page, not the absence of a visible error, and not a report from
whoever watched it happen. When someone else is driving the publish, that line
is the thing to ask for, verbatim.

This is the same shape as the pasted-gates lesson above: a step whose failure
is invisible at the point of failure, and only surfaces later as a tag pointing
at a version nobody can install.

### Post-publish verification, before the tag

Two checks. Both are free, both take seconds, and both gate
`git push origin v<x.y.z>`.

**Read the packument directly, and read the timestamp — not just the version.**
`npm view` can answer from cache, so ask the registry itself:

```
node -e "(async()=>{const j=await(await fetch('https://registry.npmjs.org/pion-mcp',{headers:{'cache-control':'no-cache'}})).json();const v=process.argv[1];console.log('latest  ',j['dist-tags'].latest);console.log('shasum  ',j.versions[v]?.dist.shasum??'ABSENT');console.log('modified',j.time.modified)})()" 0.4.1
```

A missing version is ambiguous on its own: unpublished and not-yet-propagated
look identical. `time.modified` disambiguates them. In 0.4.1 it read three days
stale while the version was absent — that is not CDN lag, that is an absent
write, and it is what justified refusing to tag. A real propagation delay moves
the timestamp; an unpublished version leaves it where it was.

**Match the shasum against the dry run.** `npm pack --dry-run` prints a shasum
before publishing and the registry publishes one after. When the two are equal,
the artifact on the registry is byte-for-byte the one that was verified locally
— the strongest *what shipped is what was checked* guarantee available here,
and it costs nothing. Both read
`079b05f452aada17b9173a59fac26acf6765851f` for 0.4.1.

Run the dry run before publishing so there is something to compare against;
without it this check has no left-hand side. A mismatch means the tree moved
between verification and publish. Do not tag — find out what moved.

---

## Directory listings — Glama

Listing: `https://glama.ai/mcp/servers/@jleeblack/pion-mcp`, claimed 2026-08-17.

### Read the API, never the page

**The listing page renders our own `README.md` alongside Glama's stored
metadata, and the two disagree.** Anything that reads the page — a human
skimming, or a fetch-and-summarise tool — can lift the current env table out of
the embedded README and report it as the listing's configuration, while the
actual Server Configuration widget still shows something years older in spirit.
That mistake was made in this repo on 2026-08-17 and produced a confident,
wrong "the listing is already current."

The machine-readable record is the only safe source:

```
https://glama.ai/api/mcp/v1/servers/jleeblack/pion-mcp
```

It returns the stored `environmentVariablesJsonSchema`, `description`,
`attributes`, and `tools` — what Glama actually believes, with no README
rendered next to it.

### What Glama stores, and how it got there

- **The environment variables are a stored, AI-inferred JSON Schema.** Not
  scraped from `README.md`, not from `--help`, not from the code — a
  `environmentVariablesJsonSchema` field frozen on the server record. The tell
  is the wording: `PION_ENABLE_PAYMENTS` reads *"Arms the send_payment tool.
  Must be set to '1' to enable payments. Off by default."*, a sentence that
  appears nowhere in this repo. It was generated from an early snapshot and has
  not moved since. **Editing the README does not fix it.**
- **Tool and parameter schemas come from the live server** — Glama's documented
  method is a real `tools/list` exchange against a build in a microVM, so every
  `.describe()` in `src/tools/` would be published verbatim. That is the
  mechanism; see the measurement below for whether it re-runs.
- **The one-line server description and `attributes` are inferred too**, and can
  be wrong: the record tags Pion `hosting:remote-capable`, which is false for a
  stdio-only server.

### Re-indexing does not demonstrably follow a push

Glama's methodology states every new commit triggers a full re-run and the
registry reflects the repository within minutes. **Measured 2026-08-18: it did
not.** Across four merged PRs and two npm publishes (0.4.1 and 0.4.2), nothing
moved — the env schema still lacked `PION_NETWORK`, and every parameter
description on the listing was still the 0.4.0 text, verbatim:

| Shown on the listing | Actual since 0.4.1 |
|---|---|
| `Pi wallet address (Stellar public key, 56 characters, starts with G)` | full alphabet, case rule, worked example |
| `Transaction hash (64 hex characters)` | case handling, not-a-payment-id, worked example |

The scores were unchanged for the same reason, and that is the trap worth
naming: **an unchanged score after a description rewrite reads as "the rewrite
did not help" when it actually means "the rewrite was never seen."** Confirm
the listing is scoring current text — quote a parameter string back — before
drawing any conclusion about whether a change worked.

So treat the listing as pull-on-request, not push-driven. The levers are the
claim flow and whatever the maintainer dashboard exposes directly; the
`tools: []` in the API alongside tools rendered on the page suggests the stored
record is only partially populated, which is worth a look if a refresh keeps
not arriving.

### `glama.json` is not a configuration file

Its schema (`https://glama.ai/mcp/schemas/server.json`) defines exactly one
property: `maintainers`, an array of GitHub usernames. It is the ownership
claim and nothing more. It cannot declare environment variables, tools, or
metadata, so there is no listing manifest in this repo to keep in sync.

### The score that drives description work

Glama publishes a Tool Definition Quality Score over six dimensions, each 1–5.
The one worth watching is **Parameter Semantics** — *"are parameter names,
types, and constraints specified unambiguously?"*

Measured 2026-08-17, before 0.4.1: Purpose, Conciseness and Completeness were
5/5 on all four tools, while Parameter Semantics was 3/5 on `get_wallet_balance`
and `query_transaction` and 4/5 on `get_account_payments` and `verify_user`.
The split is legible: the two tools scoring 3 were the two whose *only*
parameter used a bare one-line `.describe()` stating what the value is. The
tools scoring 4 had parameters that also stated ranges, defaults, and
provenance. The dimension is rewarding stated **constraints**, not prose
quality — which is why 0.4.1 moved the alphabet, the length, the case rule, and
a worked example into the descriptions themselves rather than leaving them
implicit in the regex.

**Whether that worked is still unmeasured.** Re-checked 2026-08-18, after both
releases: identical scores — 4.3 / 4.3 / 4.5 / 4.9, Parameter Semantics still
3, 3, 4, 4. Not a result, because the listing was still scoring the 0.4.0
strings (see "Re-indexing" above). The reading above remains a hypothesis about
what the dimension rewards, and stays one until a re-index is confirmed to have
picked up the current text.

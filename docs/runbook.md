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

```
$env:PI_SERVER_API_KEY = Read-Host "Server API key"
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
npm run wallet GAXGSA3464LANSVET73TXYDWDCLFLSW26HAG3XZVD2CCQA5QYWBUZWMT
```

**Current app wallet: `GAXGSA3464LANSVET73TXYDWDCLFLSW26HAG3XZVD2CCQA5QYWBUZWMT`**
(replaced 2026-07-31; the previous one is retired — see `pi-sdk-notes.md`).

That check proves the secret matches the address you typed. It does **not**
prove Pi agrees this is the app wallet — for that, the address has to come from
Pi rather than from you. `npm run probe:a2u <uid>` prints `from_address` on the
create response, which is Pi's own answer. After replacing a wallet, run it
once and confirm `from_address` is the address above; the probe cancels its own
record, so this costs nothing.

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

### If a send fails anyway

`send_payment` reports which step it reached, and that determines what to do:

| Step | What happened | Action |
|---|---|---|
| `create` | No record, no funds moved | Safe to retry |
| `submit` | Record created, nothing signed | Cancel the stranded id before retrying — never retry blind, it creates a second payment for the same intent |
| `complete` | **Funds have left the wallet**, Pi not notified | Do NOT retry. Complete manually via `POST /v2/payments/{id}/complete` with the txid |

A `submit`-stage failure with no payment id in the message means the response
could not be parsed; find the record with `npm run incomplete`.

### Verifying the code without a live payment

`npm run u2a` exercises both functions against a local stub — the refusal paths,
the id validation, the status mapping, and the rule that completion is reported
only on a 200. No real API contact, fake key. Run it before deploying a change
to either function.

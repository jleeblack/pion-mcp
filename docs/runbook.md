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

### Verifying the code without a live payment

`npm run u2a` exercises both functions against a local stub — the refusal paths,
the id validation, the status mapping, and the rule that completion is reported
only on a 200. No real API contact, fake key. Run it before deploying a change
to either function.

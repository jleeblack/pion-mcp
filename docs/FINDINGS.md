# Four undocumented Pi Platform API behaviours

Found while building [Pion](https://github.com/jleeblack/pion-mcp), an MCP server
for Pi Network, against `api.minepi.com/v2` on **Pi Testnet**, July–August 2026.

Each finding below is stated with the verbatim response that produced it, so you
can check the claim rather than take our word for it. Where a transaction is
involved the hash is real and public — look it up on
[Horizon](https://api.testnet.minepi.com) or
[Pi's block explorer](https://blockexplorer.minepi.com/testnet).

Two redactions, both deliberate: app-scoped **uids** and the **recipient's**
wallet address are replaced with placeholders. A uid identifies a real person
within one app, and this repository is public. Transaction hashes and the *app*
wallet are unredacted, so every claim stays independently verifiable.

All four are **testnet observations**. We have not tested mainnet, and A2U is
testnet-only per Pi's own `payments_advanced.md`.

---

## 1. `metadata` is required and must be non-empty

`POST /v2/payments` rejects a payment whose `metadata` is `{}`. The field reads
as optional; it is not.

```
HTTP 400
{"error":"invalid_metadata","error_message":"Metadata can't be empty."}
```

Any non-empty object is accepted.

**Why it is easy to miss.** Our own probe tooling always sent
`{ "probe": true }`, so every exploratory call satisfied a requirement nobody
knew existed. It surfaced on the first call that omitted the field — a real
payment, not a test. An assumption exercised repeatedly is not thereby tested,
if the test data happens to satisfy it.

**Handling.** Send something. Pion defaults to `{ "source": "pion-mcp" }` when a
caller supplies nothing.

---

## 2. A2U creation is gated on the *recipient's* consent, and fails as a 401

`POST /v2/payments` refuses unless the recipient has granted your app the
`wallet_address` scope, so Pi can resolve their wallet.

```
HTTP 401
{"error":"missing_scope",
 "error_message":"User hasn't authorized \"wallet_address\" scope for you to
                  access the public key."}
```

**Three things make this misleading.**

It arrives as **401**, which otherwise means "bad API key" — so the body must be
read to tell a consent problem from a credential problem. Your key is fine.

The missing consent is the **recipient's**, not yours. A valid uid is not
sufficient, and no action on your side fixes it.

It is **permanent, not transient**. Retrying will never succeed. An agent that
treats 401 as retryable will loop forever.

**Consequence for the "app pays user" primitive:** you cannot pay an arbitrary
uid. You can only pay users who have already consented to receive from your
specific app.

**Unresolved:** whether a `wallet_address` consent collected through Pi Sign-in
(OAuth) satisfies this, or whether only a Pi Browser SDK grant does. We have
verified the Browser SDK route works. We have not cleanly tested the Sign-in
route in either direction and make no claim about it.

---

## 3. The fee floor makes dust-sized payments irrational

A minimum-amount A2U payment on testnet:

| | |
|---|---|
| amount sent | `0.0000001` Pi (1 stroop) |
| fee charged | `100000` stroops = **`0.01` Pi** |
| ratio | **100,000×** |
| txid | `fb271ed0074847ec4bb62c76241d947f0e1439d4d3b056064f074db0f2bcc1cf` |
| ledger | 25933848 |

The fee is flat and per-transaction, set by the network (`fetchBaseFee()`), not
chosen by the sender — and it can rise under congestion, so `0.01` Pi is an
observed floor rather than a constant.

**The arithmetic that matters for design:**

| payment | fee as a share |
|---|---|
| 10 Pi | 0.1% |
| 1 Pi | 1% |
| 0.1 Pi | 10% |
| 0.01 Pi | 50% |
| below that | the fee dominates |

**Consequence.** "An agent pays a fraction of a cent per task" does not work
on-chain. Anything settling sub-`0.01`-Pi exchanges needs aggregation above the
fee floor — an off-chain credit ledger settled periodically, batched payouts per
recipient, or a threshold that withholds payment until the accumulated balance
justifies a transaction. A task board either prices work well above the floor or
batches settlement; there is no third option.

**Untested:** mainnet fee levels, and whether Pi offers any batching or
payment-channel mechanism.

---

## 4. A payment record cannot tell you whether funds moved

**This is the one that can lose money.**

Pi learns a transaction's id only when `POST /v2/payments/{id}/complete`
succeeds. Until then the record shows `transaction: null` and
`transaction_verified: false` — and it shows exactly that whether the transfer
never happened *or* already landed on-chain.

We induced both states deliberately to compare them.

**Case A — created, never submitted.** The app wallet could not sign, so nothing
reached the chain.

```jsonc
{
  "identifier": "zsaNjMnlKno38LugobU1wUdRG4LG",
  "amount": 1e-7,
  "from_address": "GATQBZLIAUVMND2OCPOKWGPUCNXIGKMNUU7E67YQI2MODSMCMLXBAIJA",
  "to_address": "<recipient redacted>",
  "user_uid": "<uid redacted>",
  "transaction": null,
  "status": {
    "developer_approved": true,
    "transaction_verified": false,
    "developer_completed": false,
    "cancelled": false,
    "user_cancelled": false
  }
}
```

**Case B — submitted, confirmed on-chain, `/complete` never delivered.** The
recipient *has been paid*.

```jsonc
{
  "identifier": "FTwFrIv38raJoR7fOazwg9RLxfbu",
  "amount": 1e-7,
  "from_address": "GATQBZLIAUVMND2OCPOKWGPUCNXIGKMNUU7E67YQI2MODSMCMLXBAIJA",
  "to_address": "<recipient redacted>",
  "user_uid": "<uid redacted>",
  "transaction": null,
  "status": {
    "developer_approved": true,
    "transaction_verified": false,
    "developer_completed": false,
    "cancelled": false,
    "user_cancelled": false
  }
}
```

The two records are identical in every field that bears on the question.

Case B's transfer is real and public — verify it yourself:

```
txid   b0f67c67fb3fd196c044e2af28cb0058fb51a6c4a094d48e993d55b3a0ec8b76
ledger 25934416
successful: true
GATQBZLI… → <recipient> — 0.0000001 PI
```

**Consequences.**

`GET /v2/payments/incomplete_server_payments` lists both, indistinguishably. A
listing is **not** a statement that nothing was sent.

Cancelling on the strength of `transaction: null` can cancel a payment the
recipient has already received — converting a recoverable strand into a silent
loss. Nothing in Pi's data prevents this and nothing in the documentation warns
about it.

**Handling.** The chain is the only authority, and it can answer because the
**payment identifier is the on-chain Stellar text memo**:

```
memo_type: "text"
memo:      "FTwFrIv38raJoR7fOazwg9RLxfbu"   ← equals the payment identifier
```

So before cancelling, search the sending wallet's transactions for a successful
one whose memo equals the payment identifier. If it exists, the payment must be
*completed* with that txid, never cancelled.

Two edges worth building in:

- **Horizon ingestion lag.** A transaction submitted seconds ago may not be
  queryable yet, so a search run immediately can report a false "nothing
  on-chain" — reproducing exactly the loss you are preventing. Require a minimum
  record age before trusting a negative.
- **Inconclusive is not "no."** Horizon unreachable, a non-200, or a truncated
  search should refuse to cancel rather than assume. An unnecessary refusal
  leaves a record listed; a wrong cancel loses funds.

---

## A note on the identifier length

Pi payment identifiers are **exactly 28 characters** of base62 ASCII — precisely
the Stellar `memo_text` limit — across **eight** samples spanning both payment
directions. That is almost certainly deliberate, and it has a pleasant
consequence: the identifier fits the memo with zero bytes to spare, which is
what makes finding 4's recovery possible at all.

It also means the memo slot is fully spoken for. Nothing else can ride there —
no prefix, no tag — so an A2U implementation that decorates the memo will
overflow it.

---

*Corrections welcome. Every claim here is reproducible on testnet, and we would
rather be corrected than confidently wrong — one item in this file replaced an
earlier conclusion of ours that the evidence did not support.*

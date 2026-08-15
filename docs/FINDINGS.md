# Five undocumented Pi Network behaviours

Found while building [Pion](https://github.com/jleeblack/pion-mcp), an MCP server
for Pi Network, against the Platform API (`api.minepi.com/v2`) and Pi's public
Horizon nodes, July–August 2026.

Each finding below is stated with the verbatim response that produced it, so you
can check the claim rather than take our word for it. Where a transaction is
involved the hash is real and public — look it up on
[Horizon](https://api.testnet.minepi.com) or
[Pi's block explorer](https://blockexplorer.minepi.com/testnet).

Two redactions, both deliberate: app-scoped **uids** and the **recipient's**
wallet address are replaced with placeholders. A uid identifies a real person
within one app, and this repository is public. Transaction hashes and the *app*
wallet are unredacted, so every claim stays independently verifiable.

## The two that matter most

Findings 1–3 are things that **fail**, and a thing that fails teaches you about
itself. Findings **4 and 5 are a different and worse category: they answer.**

- A payment record reports `transaction: null` whether the money moved or not.
- A wallet address returns a balance from whichever chain you asked, and the
  same address can hold a different balance on each.

Neither raises an error. Neither looks unusual. In both cases the wrong answer
is well-formed, plausible, and indistinguishable from the right one at the point
you receive it — which means no amount of checking *the response* catches it.
Only an independent source does. That is the shared hazard, and it is why both
findings end with a specific external check rather than advice to validate more
carefully.

If you read only two sections here, read those.

## Scope

Findings 1, 2 and 4 are **testnet observations of the Platform API**. A2U is
testnet-only per Pi's own `payments_advanced.md`, so there is no mainnet
equivalent to compare them against.

Findings 3 and 5 have been **checked on both chains**, since Horizon reads are
open on mainnet as well as testnet.

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

**Mainnet is the same** (checked 2026-08-14). Both chains report a base fee of
100,000 stroops, and a real mainnet transaction was charged exactly that. If
anything mainnet is steadier: every `/fee_stats` percentile sat flat at the
floor, while testnet showed p90 at 169,046. The arithmetic above therefore
applies to real Pi, not just test Pi.

**Still untested:** the fee on a mainnet *A2U* payment specifically — Pi does
not currently permit those — and whether Pi offers any batching or
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

## 5. The same address holds different balances on Mainnet and Testnet

**This is finding 4's hazard, one layer down.** Query the wrong chain and you
are not told. You are answered.

Pi Mainnet and Pi Testnet are separate ledgers that share Stellar's address
format. The intuition that follows — *if I query the wrong network I will get a
not-found* — is false. Measured 2026-08-14, the same address, at the same
moment, on both chains:

```
GCZYTVXS2K7DY3LJ6F3P5CVH3OU4ZGUKAXAUTE3K7NZGNH55ONISQCMB

  api.mainnet.minepi.com   balance  2.0600000 PI   sequence 107166829968883735
  api.testnet.minepi.com   balance 32.2993800 PI   sequence  45199857865982412
```

Both responses are HTTP 200. Both are well-formed. Neither names a network
anywhere in its body. Sampling six accounts drawn from recent mainnet ledgers,
**three also existed on testnet and three returned 404** — so co-existence is
common but not reliable, which is the worst of both worlds: too common to be an
edge case, too unreliable to use as a signal.

**Why it is easy to miss.** Absence *feels* like a safety net. A developer who
points a client at the wrong Horizon expects the mistake to announce itself as a
wall of 404s, and if the first address they test happens to be one of the
testnet-only ones, it does — which teaches exactly the wrong lesson before the
first address that exists on both silently returns 32 Pi where 2 Pi was true.
Testnet Pi is worthless and mainnet Pi is not, so the error runs in the
expensive direction.

**Handling.** The network is not derivable from the response, so it has to be
carried alongside it. Two things follow, and they are cheap:

- **Resolve the network once**, in one place, and let the Horizon client, the
  logs, and every result read that single value. Deriving it independently in
  two places — say, by testing whether the URL contains `"testnet"` — is how a
  configuration ends up testnet by one check and mainnet by another.
- **Label every result, not just startup.** Anyone reading a balance an hour
  into a session never saw the banner.

**Verifying it yourself.** Do not test with an address that exists on only one
chain — that is the case which passes for the wrong reason. Take an address
present on both and confirm the two chains return *different* ledger state.
Same address, two answers, is a positive proof the chains are distinguished; a
404 elsewhere proves only that one address is missing from one chain.

The same round of mainnet checks also settled finding 3's open question about
fee levels; the answer is recorded there.

**Not claimed.** That Pi derives one keypair per passphrase across both
networks. Co-existence proves the same *public key* is registered on both
chains; it does not establish the mechanism, and we have not tested it.

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

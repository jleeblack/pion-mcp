# Pre-mainnet verification list

Things that must be answered **before** a mainnet key exists, not after. Each
one is a question whose answer changes what we build or how we respond to an
incident — and each is cheap to answer now and expensive to discover later.

Testnet is the place to resolve all of these, because the cost of being wrong
here is a worthless balance.

---

## P0 — answer before any mainnet credential is created

### Does app-wallet deletion exist on mainnet?

Retired app wallets on testnet **cannot be deleted**. They stay in the Portal's
wallet selector indefinitely and stay funded (`pi-sdk-notes.md`).

Why this is P0: if a mainnet app wallet key leaks, the response is to create a
replacement and select it — but the compromised wallet then remains in the
selector permanently, one mis-click from being the live spending account again.
If deletion does not exist on mainnet either, "remove the compromised wallet"
is not an available action, and the incident response has to be built around
that fact rather than discovering it mid-incident.

Answering it also decides whether draining a retired wallet is a nicety or the
only available mitigation.

### Do Pi's testnet and mainnet wallets share a key derivation?

If both are derived from the same passphrase, a "testnet-only" seed exposure is
a mainnet exposure wearing a disguise, and the secret exposure policy in
`runbook.md` sorts it into the wrong bucket. The policy currently marks its
testnet-tolerant branch as conditional on this answer.

---

## P1 — answer before shipping A2U against mainnet

### Is A2U available on mainnet at all?

`payments_advanced.md` states A2U is "currently available only on the Testnet."
Until that changes, mainnet A2U is not a build target and the arming guard
correctly refuses it.

### Does a Pi Sign-in `wallet_address` consent satisfy A2U create?

Untested in both directions (`tool-mapping.md`). Decides whether A2U can reach
anyone who completed an OAuth flow, or only users onboarded through the Pi
Browser — the difference between a general capability and a narrow one.

---

## Answered

- **Can a compromised app wallet be replaced?** Yes. Creation and selection are
  separate steps; selecting takes effect within seconds (2026-08-01). App
  wallets are not pinned.

- **Mainnet Horizon URL and network passphrase** (2026-08-14, v0.4).
  `https://api.mainnet.minepi.com`, passphrase **`Pi Network`** — *not*
  "Pi Mainnet", which appears in Pi's own explorer only as UI copy. Full
  evidence in `pi-sdk-notes.md`, Layer 3. Arming no longer depends on this being
  unknown: it now requires the resolved network to *be* Pi Testnet, so mainnet
  is refused by identity rather than by a URL substring that happened to fail.

- **Do mainnet transaction fees differ from testnet's 0.01 Pi?** No. Both chains
  report a base fee of **100,000 stroops (0.01 Pi)**, confirmed on a real
  mainnet transaction. Mainnet showed no congestion spread; testnet did. The
  fee-floor arithmetic in `FINDINGS.md` §3 carries over unchanged.

  Still unknown: whether Pi offers fee-bumping, batching, or payment-channel
  mechanisms that would let sub-floor exchanges settle economically — and the
  fee on a mainnet *A2U* specifically, which Pi does not currently permit.

- **Partial evidence on shared key derivation.** The P0 question above is not
  closed, but there is now data: the same address can hold balances on both
  chains simultaneously (`pi-sdk-notes.md`, Layer 3). That proves one public key
  is registered on both, which is consistent with a shared derivation and points
  the P0 answer toward "treat a testnet seed exposure as a mainnet exposure" —
  but it does not establish the mechanism, so the policy branch in `runbook.md`
  stays conditional.

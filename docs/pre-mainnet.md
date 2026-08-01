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

### Mainnet Horizon URL and network passphrase

Documented only for testnet (`api.testnet.minepi.com`, passphrase `Pi Testnet`).
`checkPaymentsArming` refuses any Horizon URL without `testnet` in it, so this
is currently a hard block by design rather than an oversight.

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

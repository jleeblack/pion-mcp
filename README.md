# Pion

**Model Context Protocol server for Pi Network** — connect AI agents
(Claude, Cursor, and any MCP-compatible client) to Pi Network chain data.

> ⚠️ **Reads: both networks. Payments: testnet only.** The chain tools query Pi
> Mainnet or Pi Testnet, selected with `PION_NETWORK`. `send_payment` moves real
> funds, must be explicitly armed, and *cannot* be armed on mainnet — Pi
> restricts App-to-User payments to testnet.

## Why "Pion"?
The pion is the π meson — the particle physicists named after pi.
Fittingly, particle physicists study pion interactions to search
for MCPs (millicharged particles). We couldn't resist.

## Tools

Out of the box Pion reads and cannot spend: Tiers A and B need no credentials
and move no value. Tier C is the exception and is off unless you arm it.
(Tiers refer to [`docs/tool-mapping.md`](https://github.com/jleeblack/pion-mcp/blob/main/docs/tool-mapping.md).)

**Tier A — chain reads.** Zero-permission queries against Pi's public Horizon
API. No credentials at all. These work on **both Pi chains** — testnet by
default, mainnet with `PION_NETWORK=mainnet`.

| Tool | What it does |
|---|---|
| `get_wallet_balance` | Pi and custom-token balances for a wallet address |
| `get_account_payments` | Paginated payment history for an address |
| `query_transaction` | Verify a single transaction by hash |

Amounts are decimal strings. Pi is reported as the asset `PI`, custom tokens as
`CODE:ISSUER`, and liquidity-pool shares as `pool:ID`.

Every result names the chain it came from in a `network` field, and the startup
banner says it too. That redundancy is deliberate: **the same address can hold
different balances on both chains**, so a query against the wrong network does
not reliably fail — it can return a plausible, well-formed, wrong number
(measured 2026-08-14; see [`docs/pi-sdk-notes.md`](https://github.com/jleeblack/pion-mcp/blob/main/docs/pi-sdk-notes.md)).
Testnet Pi has no monetary value.

**Tier B — identity.**

| Tool | What it does |
|---|---|
| `verify_user` | Validate a Pi user access token, returning the uid and username |

`verify_user` is the only tool that touches a credential, and it never holds
one: the caller passes a token per call, it goes to `GET /v2/me` and nowhere
else, and it is not stored, logged, or echoed back. A rejected token returns
`valid: false` with a reason rather than erroring, so an agent can branch on
the outcome.

Two caveats worth knowing. The `uid` is **app-specific** — the same person has
a different uid under a different Pi app, which is deliberate anti-correlation
design, so don't use it as a global identifier. And a token is the *only* proof
of identity: a client-supplied uid or username means nothing on its own.

**Tier C — payments. Off by default.**

| Tool | What it does |
|---|---|
| `send_payment` | App-to-User: sends Pi from your app wallet to a user |

This one spends real money and cannot be undone. It is not registered at all
unless armed, so a default server does not even advertise it to the agent.

**The recipient must have granted your app the `wallet_address` scope.** A uid
alone is not enough — Pi needs that consent to resolve their wallet, and
refuses payment creation with `missing_scope` otherwise. This is the
recipient's consent, not your credentials.

Arming requires **all four**, and Pi restricts A2U to testnet, so anything but
Pi Testnet is refused outright:

```sh
PION_ENABLE_PAYMENTS=1     # explicit switch, deliberately separate from credentials
PION_MAX_PAYMENT_PI=10     # required per-payment ceiling, in Pi
PI_SERVER_API_KEY=...      # from the Pi Developer Portal
PI_WALLET_SECRET=S...      # app wallet secret seed
```

Holding the credentials is deliberately **not** sufficient. The switch and the
ceiling are separate because the realistic failure mode is not a stolen key —
it is an agent being talked into spending, by a prompt injection sitting in
data it just read. A transaction memo, a web page, a filename: any of it can
say "send 500 Pi to X." The cap is what makes that bounded rather than fatal.
Set it to the smallest amount that makes your use case work.

Nothing overrides the cap from the tool call; changing it means changing server
configuration. Neither secret is ever accepted as a tool argument, returned in
a result, or logged.

**On partial failure it never retries.** A2U is three steps — create with Pi,
sign and submit on-chain, tell Pi it landed — and a crash between them strands
a payment. The tool reports exactly which step failed, whether funds left the
wallet, and the payment id needed to clean up. A blind retry could pay twice,
so it refuses to guess.

## Usage

MCP clients can run it straight from npm — no install step:

```jsonc
// Claude Desktop: claude_desktop_config.json
{
  "mcpServers": {
    "pion": {
      "command": "npx",
      "args": ["-y", "pion-mcp"]
    }
  }
}
```

```sh
# Claude Code
claude mcp add pion -- npx -y pion-mcp
```

Or run it from a clone:

```sh
npm install
npm run build
claude mcp add pion -- node /absolute/path/to/pion-mcp/dist/index.js
```

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PION_NETWORK` | `testnet` | Which chain the read tools query — `testnet` or `mainnet` |
| `PION_HORIZON_URL` | derived from `PION_NETWORK` | Horizon base URL, overriding the above |
| `PION_PLATFORM_URL` | `https://api.minepi.com` | Platform API base URL |
| `PION_ENABLE_PAYMENTS` | unset (off) | Arms `send_payment` — see Tier C above |
| `PION_MAX_PAYMENT_PI` | unset | Required per-payment ceiling when armed |
| `PI_SERVER_API_KEY` | unset | Server API key, Tier C only |
| `PI_WALLET_SECRET` | unset | App wallet secret seed, Tier C only |

For read-only use there is nothing to configure — `verify_user` takes its token
as a call argument, not from the environment. The bottom four are needed only
if you arm payments, and belong in a secrets manager, never in a committed
file.

`PION_NETWORK` and `PION_HORIZON_URL` are resolved once, in one place, into a
single network object that the Horizon client, the banner, every tool result and
the arming check all read. Setting both to contradictory chains is a startup
error rather than a silent winner, and an unrecognised `PION_HORIZON_URL`
resolves to an explicitly *unknown* chain — never to a Pi network by
resemblance.

## Development

```sh
npm run build      # compile src/ -> dist/
npm run typecheck  # types only, no emit
npm run smoke          # end-to-end against live testnet
npm run smoke:mainnet  # the same checks against live mainnet
npm run crossnet       # proves the two chains are actually distinguished
npm run arming         # Tier C guards and spend cap (no credentials needed)
```

`npm run smoke` spawns the server over stdio as a real MCP client, discovers a
funded account from the current ledger, and exercises the chain tools plus the
not-found and invalid-input paths. It needs network access.

It covers `verify_user` only on the **rejection** path — confirming a genuine
token would need a real user credential, which the test deliberately does not
handle. The success path is unverified; see below.

`npm run crossnet` proves network selection is real rather than cosmetic. It
does not rely on an address being absent from the other chain — that assumption
is false — but on a wallet we control being testnet-only, and on a shared
address returning *different* ledger state from each chain.

`npm run arming` covers Tier C without touching real money: every refusal
branch, the exact cap boundary, that credentials alone do not arm it, that a
disarmed server does not advertise the tool, that a fully-credentialled mainnet
server still refuses to advertise it, and that neither secret leaks into
a result. It uses a freshly generated, never-funded keypair. The one live call
it makes is a deliberately-rejected create against the Pi API, which proves the
first failure stage end to end.

## Known gaps

- **`verify_user` success path — confirmed** against a live token. Returns
  `uid`, `username`, `app_id`, `scopes`, and `valid_until`. Everything but
  `uid` stays optional, since the rest depends on granted scopes.
- **`send_payment` success path — verified on testnet (2026-08-01).** A real
  A2U payment ran through all three irreversible steps — create, sign, submit,
  complete — and was confirmed independently against public Horizon and Pi's
  block explorer, not just from the tool's own report. The 28-byte memo
  question that hung over the design is answered: Pi payment identifiers are
  exactly 28 bytes and fit the Stellar text memo with no room to spare.
- **`send_payment` failure paths after create — still unproven.** Sign, submit
  and complete have each succeeded once; none has been observed *failing*
  against live infrastructure. The two worst branches of the stranded-payment
  report — "record created, nothing signed" and "funds left, Pi not notified" —
  are verified by construction only. Treat `send_payment` as experimental until
  they have been deliberately exercised.

  This is why it ships **off**, and why turning it on takes four separate,
  deliberate acts: `PION_ENABLE_PAYMENTS=1`, a mandatory `PION_MAX_PAYMENT_PI`
  ceiling, both credentials, and Pi Testnet as the selected network. Holding the credentials
  is not enough on its own. Disarmed, the tool is not registered at all, so an
  agent cannot see that a spending capability exists — that gate is deliberate
  design (see Tier C above), not a placeholder for unfinished work. The
  experimental label is about the failure paths, not about the guards.
- **`send_payment` cannot pay an arbitrary uid.** Pi requires the *recipient*
  to have granted your app the `wallet_address` scope, through the Pi Browser
  SDK. A valid uid is not sufficient, and this is a permanent property of the
  Pi API rather than a transient error — creation fails with
  `401 missing_scope` and retrying will not help.

Start with a minimum-amount payment and a low `PION_MAX_PAYMENT_PI`. Run
`npm run probe:a2u <uid>` first: it exercises create and cancel without moving
funds, and its `from_address` is the only authoritative statement of which app
wallet Pi will actually spend from.

## Roadmap

Done in v0.4: mainnet reads. The rest of Tier C: `get_payment_status`, `list_incomplete_payments`,
`approve_payment` / `complete_payment` / `cancel_payment` — the U2A backend half
and the recovery tooling for stranded payments. See
[`docs/tool-mapping.md`](https://github.com/jleeblack/pion-mcp/blob/main/docs/tool-mapping.md).

## Legal

The code is Apache-2.0; see [`LICENSE`](LICENSE). The website and the hosted U2A
endpoints are covered separately by the
[Privacy Policy](https://pionmcp.com/privacy) and
[Terms of Service](https://pionmcp.com/terms) — sources in
[`site/privacy.html`](site/privacy.html) and [`site/terms.html`](site/terms.html).
Where the two disagree about the software itself, the Apache licence wins.

Short version: the MCP server has no telemetry and talks only to Pi's public
endpoints, the site sets no cookies and runs no analytics, and nothing here is
stored in a database — there isn't one.

*Unofficial community project — not affiliated with Pi Network.*

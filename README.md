# Pion

**Model Context Protocol server for Pi Network** — connect AI agents
(Claude, Cursor, and any MCP-compatible client) to Pi Network chain data.

> ⚠️ Testnet only. Read-only by default; `send_payment` moves real funds and
> must be explicitly armed.

## Why "Pion"?
The pion is the π meson — the particle physicists named after pi.
Fittingly, particle physicists study pion interactions to search
for MCPs (millicharged particles). We couldn't resist.

## Tools

Out of the box Pion reads and cannot spend: Tiers A and B need no credentials
and move no value. Tier C is the exception and is off unless you arm it.
(Tiers refer to [`docs/tool-mapping.md`](docs/tool-mapping.md).)

**Tier A — chain reads.** Zero-permission queries against Pi's public Horizon
API. No credentials at all.

| Tool | What it does |
|---|---|
| `get_wallet_balance` | Pi and custom-token balances for a wallet address |
| `get_account_payments` | Paginated payment history for an address |
| `query_transaction` | Verify a single transaction by hash |

Amounts are decimal strings. Pi is reported as the asset `PI`, custom tokens as
`CODE:ISSUER`, and liquidity-pool shares as `pool:ID`.

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

Arming requires **all four**, and Pi restricts A2U to testnet, so a non-testnet
Horizon URL is refused outright:

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
| `PION_HORIZON_URL` | `https://api.testnet.minepi.com` | Horizon base URL |
| `PION_PLATFORM_URL` | `https://api.minepi.com` | Platform API base URL |
| `PION_ENABLE_PAYMENTS` | unset (off) | Arms `send_payment` — see Tier C above |
| `PION_MAX_PAYMENT_PI` | unset | Required per-payment ceiling when armed |
| `PI_SERVER_API_KEY` | unset | Server API key, Tier C only |
| `PI_WALLET_SECRET` | unset | App wallet secret seed, Tier C only |

For read-only use there is nothing to configure — `verify_user` takes its token
as a call argument, not from the environment. The bottom four are needed only
if you arm payments, and belong in a secrets manager, never in a committed
file. The mainnet Horizon URL is still an open
question — see the TODO in [`docs/pi-sdk-notes.md`](docs/pi-sdk-notes.md).

## Development

```sh
npm run build      # compile src/ -> dist/
npm run typecheck  # types only, no emit
npm run smoke      # end-to-end: drives the built server against live testnet
npm run arming     # Tier C guards and spend cap (no credentials needed)
```

`npm run smoke` spawns the server over stdio as a real MCP client, discovers a
funded account from the current ledger, and exercises the chain tools plus the
not-found and invalid-input paths. It needs network access.

It covers `verify_user` only on the **rejection** path — confirming a genuine
token would need a real user credential, which the test deliberately does not
handle. The success path is unverified; see below.

`npm run arming` covers Tier C without touching real money: every refusal
branch, the exact cap boundary, that credentials alone do not arm it, that a
disarmed server does not advertise the tool, and that neither secret leaks into
a result. It uses a freshly generated, never-funded keypair. The one live call
it makes is a deliberately-rejected create against the Pi API, which proves the
first failure stage end to end.

## Known gaps

- **`verify_user` success path — confirmed** against a live token. Returns
  `uid`, `username`, `app_id`, `scopes`, and `valid_until`. Everything but
  `uid` stays optional, since the rest depends on granted scopes.
- **`send_payment` success path — untested end to end.** No A2U payment has
  ever been sent with this code: that needs a real server API key and a funded
  testnet wallet. What *is* verified is every guard, the cap boundary, and the
  create-step failure. The sign, submit, and complete steps are unproven. Send
  a minimum-amount payment with a low cap as your first real run.

One known unknown inside that, and it may be fatal to the current design: Pi
matches the on-chain transaction by putting the payment identifier in a Stellar
text memo, capped at **28 bytes**. Pi issues UUIDs elsewhere in the same API —
a user uid is a 36-character UUID — and 36 does not fit in 28. If payment
identifiers follow suit, the documented memo approach cannot work as written.
`send_payment` detects this after create and refuses *before* signing, so it
fails safely, but the design would need revisiting. `npm run probe:a2u`
answers this without moving funds.

## Roadmap

The rest of Tier C: `get_payment_status`, `list_incomplete_payments`,
`approve_payment` / `complete_payment` / `cancel_payment` — the U2A backend half
and the recovery tooling for stranded payments. See
[`docs/tool-mapping.md`](docs/tool-mapping.md).

*Unofficial community project — not affiliated with Pi Network.*

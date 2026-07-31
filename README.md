# Pion

**Model Context Protocol server for Pi Network** — connect AI agents
(Claude, Cursor, and any MCP-compatible client) to Pi Network chain data.

> ⚠️ v0.2 — testnet, read-only. Nothing here can move value.

## Why "Pion"?
The pion is the π meson — the particle physicists named after pi.
Fittingly, particle physicists study pion interactions to search
for MCPs (millicharged particles). We couldn't resist.

## Tools

Nothing here can move value. No server API key or wallet secret is read
anywhere. (Tiers refer to [`docs/tool-mapping.md`](docs/tool-mapping.md).)

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

There are no secrets to configure — `verify_user` takes its token as a call
argument, not from the environment. The mainnet Horizon URL is still an open
question — see the TODO in [`docs/pi-sdk-notes.md`](docs/pi-sdk-notes.md).

## Development

```sh
npm run build      # compile src/ -> dist/
npm run typecheck  # types only, no emit
npm run smoke      # end-to-end: drives the built server against live testnet
```

`npm run smoke` spawns the server over stdio as a real MCP client, discovers a
funded account from the current ledger, and exercises the chain tools plus the
not-found and invalid-input paths. It needs network access.

It covers `verify_user` only on the **rejection** path — confirming a genuine
token would need a real user credential, which the test deliberately does not
handle. The success path is unverified; see below.

## Roadmap

Tier C is next: App-to-User payments behind env config (`PI_SERVER_API_KEY`,
`PI_WALLET_SECRET`), testnet-default with explicit opt-in for anything that
moves value. See [`docs/tool-mapping.md`](docs/tool-mapping.md).

Known gap: `verify_user`'s success-path response shape is built from the Pi
platform docs, not observed traffic. The `uid` field is reliable; `username`
and `credentials` depend on granted scopes and are treated as optional. Worth
confirming against a real token before depending on them.

*Unofficial community project — not affiliated with Pi Network.*

# Pion

**Model Context Protocol server for Pi Network** — connect AI agents
(Claude, Cursor, and any MCP-compatible client) to Pi Network chain data.

> ⚠️ v0.1 — testnet, read-only. Not yet published to npm.

## Why "Pion"?
The pion is the π meson — the particle physicists named after pi.
Fittingly, particle physicists study pion interactions to search
for MCPs (millicharged particles). We couldn't resist.

## Tools

All three are zero-permission reads against Pi's public Horizon API
(Tier A in [`docs/tool-mapping.md`](docs/tool-mapping.md)). **No API keys, no
wallet secrets, no user consent** — and nothing here can move value.

| Tool | What it does |
|---|---|
| `get_wallet_balance` | Pi and custom-token balances for a wallet address |
| `get_account_payments` | Paginated payment history for an address |
| `query_transaction` | Verify a single transaction by hash |

Amounts are decimal strings. Pi is reported as the asset `PI`, custom tokens as
`CODE:ISSUER`, and liquidity-pool shares as `pool:ID`.

## Usage

Once published, MCP clients can run it straight from npm — no install step:

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

Until then, run it from a clone:

```sh
npm install
npm run build
claude mcp add pion -- node /absolute/path/to/pion-mcp/dist/index.js
```

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PION_HORIZON_URL` | `https://api.testnet.minepi.com` | Horizon base URL |

There are no secrets to configure. The mainnet Horizon URL is still an open
question — see the TODO in [`docs/pi-sdk-notes.md`](docs/pi-sdk-notes.md).

## Development

```sh
npm run build      # compile src/ -> dist/
npm run typecheck  # types only, no emit
npm run smoke      # end-to-end: drives the built server against live testnet
```

`npm run smoke` spawns the server over stdio as a real MCP client, discovers a
funded account from the current ledger, and exercises all three tools plus the
not-found and invalid-input paths. It needs network access.

## Roadmap

v0.2 adds Tier B/C behind env config (`PI_SERVER_API_KEY`, `PI_WALLET_SECRET`):
user verification and App-to-User payments, testnet-default with explicit
opt-in for anything that moves value. See [`docs/tool-mapping.md`](docs/tool-mapping.md).

*Unofficial community project — not affiliated with Pi Network.*

#!/usr/bin/env node
/**
 * Pion — MCP server for Pi Network.
 *
 * v0.1 scope: Tier A only (see docs/tool-mapping.md) — zero-permission,
 * read-only chain queries against Pi's public Horizon API. No API keys, no
 * wallet secrets, no user consent required, and nothing here can move value.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { HORIZON_URL } from "./horizon.js";
import { registerGetAccountPayments } from "./tools/get-account-payments.js";
import { registerGetWalletBalance } from "./tools/get-wallet-balance.js";
import { registerQueryTransaction } from "./tools/query-transaction.js";

// Kept in sync with package.json by hand — it is the only duplicated string.
const VERSION = "0.1.0";

const NETWORK = HORIZON_URL.includes("testnet") ? "Pi Testnet" : `custom (${HORIZON_URL})`;

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    [
      `pion-mcp ${VERSION} — MCP server for Pi Network (read-only)`,
      "",
      "Runs an MCP server over stdio. Point an MCP client at it rather than",
      "invoking it directly.",
      "",
      "Tools: get_wallet_balance, get_account_payments, query_transaction",
      "",
      "Environment:",
      "  PION_HORIZON_URL  Horizon base URL (default: https://api.testnet.minepi.com)",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const server = new McpServer(
  { name: "pion-mcp", version: VERSION },
  {
    instructions:
      `Pion exposes read-only Pi Network chain data from Horizon at ${HORIZON_URL} ` +
      `(${NETWORK}). All three tools are public ledger reads: they cannot send payments, ` +
      "sign anything, or access a user's wallet. Amounts are decimal strings; Pi itself " +
      'is reported as the asset "PI" and custom tokens as "CODE:ISSUER".',
  },
);

registerGetWalletBalance(server, NETWORK);
registerGetAccountPayments(server, NETWORK);
registerQueryTransaction(server, NETWORK);

async function main(): Promise<void> {
  // stdout is the JSON-RPC channel — every log line must go to stderr.
  await server.connect(new StdioServerTransport());
  console.error(`pion-mcp ${VERSION} ready on stdio — Horizon: ${HORIZON_URL} (${NETWORK})`);
}

main().catch((error: unknown) => {
  console.error("pion-mcp failed to start:", error);
  process.exit(1);
});

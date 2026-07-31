#!/usr/bin/env node
/**
 * Pion — MCP server for Pi Network.
 *
 * Scope (see docs/tool-mapping.md):
 *   Tier A — zero-permission, read-only chain queries against Pi's public
 *            Horizon API. No credentials of any kind.
 *   Tier B — verify_user, which validates a *user* access token supplied by
 *            the caller against the Platform API.
 *
 * No server API key or wallet secret is read anywhere in this server, and no
 * tool can move value.
 */
import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { HORIZON_URL } from "./horizon.js";
import { PLATFORM_URL } from "./platform.js";
import { registerGetAccountPayments } from "./tools/get-account-payments.js";
import { registerGetWalletBalance } from "./tools/get-wallet-balance.js";
import { registerQueryTransaction } from "./tools/query-transaction.js";
import { registerVerifyUser } from "./tools/verify-user.js";

// Single source of truth for the version. `../package.json` resolves to the
// package root from both dist/index.js and src/index.ts, so this is correct
// whether running the build or the sources directly. Resolved at runtime
// rather than imported so the JSON never has to be copied into dist/.
const { version: VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

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
      "Tools: get_wallet_balance, get_account_payments, query_transaction, verify_user",
      "",
      "Environment:",
      "  PION_HORIZON_URL   Horizon base URL (default: https://api.testnet.minepi.com)",
      "  PION_PLATFORM_URL  Platform API base URL (default: https://api.minepi.com)",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const server = new McpServer(
  { name: "pion-mcp", version: VERSION },
  {
    instructions:
      `Pion exposes read-only Pi Network data. get_wallet_balance, get_account_payments, ` +
      `and query_transaction are public ledger reads from Horizon at ${HORIZON_URL} ` +
      `(${NETWORK}), needing no credentials. Amounts are decimal strings; Pi itself is ` +
      'reported as the asset "PI", custom tokens as "CODE:ISSUER", and liquidity-pool ' +
      'shares as "pool:ID". verify_user is different: it checks a user access token ' +
      `against the Pi Platform API at ${PLATFORM_URL} and requires the caller to supply ` +
      "that token. No tool here can send payments, sign anything, or spend from a wallet.",
  },
);

registerGetWalletBalance(server, NETWORK);
registerGetAccountPayments(server, NETWORK);
registerQueryTransaction(server, NETWORK);
registerVerifyUser(server);

async function main(): Promise<void> {
  // stdout is the JSON-RPC channel — every log line must go to stderr.
  await server.connect(new StdioServerTransport());
  console.error(`pion-mcp ${VERSION} ready on stdio — Horizon: ${HORIZON_URL} (${NETWORK})`);
}

main().catch((error: unknown) => {
  console.error("pion-mcp failed to start:", error);
  process.exit(1);
});

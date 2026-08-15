#!/usr/bin/env node
/**
 * Pion — MCP server for Pi Network.
 *
 * Scope (see docs/tool-mapping.md):
 *   Tier A — zero-permission, read-only chain queries against Pi's public
 *            Horizon API. No credentials of any kind.
 *   Tier B — verify_user, which validates a *user* access token supplied by
 *            the caller against the Platform API.
 *   Tier C — send_payment (A2U), which MOVES REAL FUNDS from the app wallet.
 *            Disabled unless explicitly armed; see src/payments.ts.
 *
 * Tiers A and B read no credentials from the environment and cannot move
 * value. Tier C is the sole exception and is off by default.
 *
 * Networks: Tier A reads either Pi chain, selected with PION_NETWORK and
 * reported in the `network` field of every result. Tier C is testnet-only —
 * Pi restricts A2U to testnet, so mainnet selection makes payments unarmable
 * rather than merely discouraged. See src/networks.ts and src/payments.ts.
 */
import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { HORIZON_URL } from "./horizon.js";
import { NETWORK, NETWORK_ERROR, NETWORK_WARNING } from "./networks.js";
import { checkPaymentsArming } from "./payments.js";
import { PLATFORM_URL } from "./platform.js";
import { registerGetAccountPayments } from "./tools/get-account-payments.js";
import { registerGetWalletBalance } from "./tools/get-wallet-balance.js";
import { registerQueryTransaction } from "./tools/query-transaction.js";
import { registerSendPayment } from "./tools/send-payment.js";
import { registerVerifyUser } from "./tools/verify-user.js";

// Single source of truth for the version. `../package.json` resolves to the
// package root from both dist/index.js and src/index.ts, so this is correct
// whether running the build or the sources directly. Resolved at runtime
// rather than imported so the JSON never has to be copied into dist/.
const { version: VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

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
      "       send_payment (only when explicitly armed — see below)",
      "",
      "Environment:",
      "  PION_NETWORK       testnet (default) or mainnet — which chain the read tools query",
      "  PION_HORIZON_URL   Horizon base URL, overriding PION_NETWORK's default",
      "  PION_PLATFORM_URL  Platform API base URL (default: https://api.minepi.com)",
      "",
      "Reads work on both Pi chains. Payments do not: Pi restricts App-to-User",
      "payments to testnet, so send_payment cannot be armed when PION_NETWORK=mainnet.",
      "",
      "Arming send_payment (all four required; testnet only):",
      "  PION_ENABLE_PAYMENTS=1  explicit switch, separate from credentials",
      "  PION_MAX_PAYMENT_PI     required per-payment ceiling, in Pi",
      "  PI_SERVER_API_KEY       Pi Developer Portal server API key",
      "  PI_WALLET_SECRET        app wallet secret seed (S...)",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// A network we cannot identify is a network we will not serve. Reported here,
// after --help/--version, so a misconfigured operator can still read the usage.
if (NETWORK_ERROR) {
  console.error(`pion-mcp: ${NETWORK_ERROR.message}`);
  process.exit(1);
}

const server = new McpServer(
  { name: "pion-mcp", version: VERSION },
  {
    instructions:
      `Pion exposes read-only Pi Network data. get_wallet_balance, get_account_payments, ` +
      `and query_transaction are public ledger reads from Horizon at ${HORIZON_URL} ` +
      `(${NETWORK.label}), needing no credentials. This server is reading ` +
      `${NETWORK.label} — every result repeats it in its "network" field, and the two Pi ` +
      `chains are separate ledgers, so an address funded on one does not exist on the ` +
      `other. Amounts are decimal strings; Pi itself is ` +
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

// Tier C is registered only when fully armed. A disarmed server does not
// advertise a payment tool at all, so an agent cannot try to spend and cannot
// be talked into thinking it might succeed.
//
// Passed the resolved network, not the URL: arming turns on what chain this
// *is*, and a string containing "testnet" is not the same claim.
const payments = checkPaymentsArming(NETWORK);
if (payments.armed) {
  registerSendPayment(server, payments.config);
}

async function main(): Promise<void> {
  // stdout is the JSON-RPC channel — every log line must go to stderr.
  await server.connect(new StdioServerTransport());

  // The chain is stated first and unabbreviated. A user who never sees this
  // line still gets it on every result, but the one who does see it should not
  // have to infer mainnet from a hostname.
  const emphasis = NETWORK.id === "mainnet" ? " — REAL VALUE" : "";
  console.error(
    `pion-mcp ${VERSION} ready on stdio — reading ${NETWORK.label}${emphasis} ` +
      `(Horizon: ${HORIZON_URL})`,
  );
  if (NETWORK_WARNING) console.error(`⚠ ${NETWORK_WARNING}`);
  console.error(
    payments.armed
      ? `⚠ send_payment ARMED — can spend up to ${payments.config.maxAmountPi} Pi per call from the app wallet`
      : `send_payment disabled — ${payments.reason}`,
  );
}

main().catch((error: unknown) => {
  console.error("pion-mcp failed to start:", error);
  process.exit(1);
});

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
      "  PION_NETWORK       testnet (default) or mainnet — which chain the read tools",
      "                     query. mainnet is echoed as REAL VALUE in the startup banner.",
      "  PION_HORIZON_URL   Override for the Horizon base URL. Optional; derived from",
      "                     PION_NETWORK when unset. If both are set they must name the",
      "                     same chain — a contradiction is a startup error, not a guess.",
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

// Tier C is registered only when fully armed. A disarmed server does not
// advertise a payment tool at all, so an agent cannot try to spend and cannot
// be talked into thinking it might succeed.
//
// Passed the resolved network, not the URL: arming turns on what chain this
// *is*, and a string containing "testnet" is not the same claim.
//
// Resolved BEFORE the server is constructed because the instructions below
// state whether a spend tool exists, and that claim has to be built from the
// same answer that decides whether one is registered. Until 0.4.2 the check
// ran afterwards and the instructions said "no tool here can send payments"
// unconditionally — false on an armed server, which is the one configuration
// where being wrong about it costs money.
const payments = checkPaymentsArming(NETWORK);

/**
 * Server instructions — the text a client places ahead of the tool catalog.
 *
 * Every session pays for this in context, so it carries only what changes a
 * decision an agent is about to make, and nothing recoverable from a tool
 * description it will read anyway.
 *
 * The cross-chain sentence is the reason this exists. It previously said an
 * address funded on one chain "does not exist on the other" — measured false
 * on 2026-08-14 (docs/FINDINGS.md finding 5): one address held 2.06 Pi on
 * mainnet and 32.29938 Pi on testnet simultaneously. That wording invited
 * exactly the wrong inference, that a wrong-chain read fails loudly. It does
 * not; it returns a plausible number. An agent needs the true version before
 * it reports a figure, not after.
 */
const instructions =
  `Pion reads Pi Network chain data. get_wallet_balance, get_account_payments and ` +
  `query_transaction are public Horizon reads at ${HORIZON_URL}, needing no ` +
  `credentials. verify_user checks a caller-supplied user access token against the ` +
  `Pi Platform API at ${PLATFORM_URL}. ` +
  `This server reads ${NETWORK.label}, and every result carries a "network" field — ` +
  `check it before trusting a figure. The two Pi chains are separate ledgers sharing ` +
  `one address format, and the same address can hold different balances on each: a ` +
  `wrong-chain read returns a plausible wrong number, not an error. Testnet Pi has no ` +
  `monetary value. Amounts are decimal strings; Pi is "PI", tokens "CODE:ISSUER", ` +
  `pool shares "pool:ID". ` +
  (payments.armed
    ? `send_payment is ARMED and can spend up to ${payments.config.maxAmountPi} Pi per ` +
      `call from the app wallet on ${NETWORK.label}; every other tool is read-only.`
    : "No tool here can send payments, sign anything, or spend from a wallet.");

const server = new McpServer({ name: "pion-mcp", version: VERSION }, { instructions });

registerGetWalletBalance(server, NETWORK);
registerGetAccountPayments(server, NETWORK);
registerQueryTransaction(server, NETWORK);
registerVerifyUser(server);

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

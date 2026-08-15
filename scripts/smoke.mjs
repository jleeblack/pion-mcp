#!/usr/bin/env node
/**
 * End-to-end smoke test: spawns the built server over stdio as a real MCP
 * client, lists its tools, and exercises all three against live Pi Horizon.
 * Requires network access. Run with `npm run smoke`.
 *
 * Runs against whichever network the environment selects, so one set of checks
 * covers both chains:
 *
 *   npm run smoke           # Pi Testnet (default)
 *   npm run smoke:mainnet   # Pi Mainnet
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { resolveNetwork } from "../dist/networks.js";

// `--network=<id>` rather than an env var, so the npm script works the same on
// Windows as it does in a POSIX shell. It just seeds PION_NETWORK, which is
// what the spawned server actually reads.
const flag = process.argv.find((arg) => arg.startsWith("--network="));
if (flag) process.env.PION_NETWORK = flag.slice("--network=".length);

// Resolved through the same code path the server uses, so fixtures are always
// discovered from exactly the chain the server under test will read.
const { network: NETWORK } = resolveNetwork(process.env);
const HORIZON = NETWORK.horizonUrl;

// Accounts are not stable across network resets and Pi publishes no fixed test
// account, so a real one is discovered from the current ledger on each run.
async function discoverFixtures() {
  const res = await fetch(`${HORIZON}/transactions?order=desc&limit=20`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Horizon ${res.status} while discovering fixtures`);
  const { _embedded } = await res.json();
  const tx = _embedded.records.find((r) => r.successful) ?? _embedded.records[0];
  if (!tx) throw new Error("no recent transactions on this network to test against");
  return { address: tx.source_account, hash: tx.hash };
}

function summarize(label, result) {
  const status = result.isError ? "ERROR" : "ok";
  const text = result.content?.[0]?.text ?? "";
  console.log(`\n── ${label} [${status}] ─────────────────────────`);
  console.log(text.length > 900 ? `${text.slice(0, 900)}\n… (truncated)` : text);
  return !result.isError;
}

const { address, hash } = await discoverFixtures();
console.log(
  `Network: ${NETWORK.label} (${HORIZON})\n` +
    `Fixtures:\n  address = ${address}\n  tx      = ${hash}`,
);

// Defaults to the local build; pass a path to test an installed copy instead,
// e.g. `node scripts/smoke.mjs ../somewhere/node_modules/pion-mcp/dist/index.js`
const entry = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "dist/index.js";
console.log(`Server entry: ${entry}`);

const client = new Client({ name: "pion-smoke", version: "0.1.0" });
// The SDK's default stdio environment is a filtered allow-list, so PION_NETWORK
// must be passed through explicitly — otherwise the child always reads testnet
// and a "mainnet" run would silently test the wrong chain.
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env },
  }),
);

const { tools } = await client.listTools();
console.log(`\nTools advertised: ${tools.map((t) => t.name).join(", ")}`);

const checks = [
  ["get_wallet_balance", { address }],
  ["get_account_payments", { address, limit: 3 }],
  ["query_transaction", { hash }],
  // Negative case: a well-formed address that does not exist on-chain.
  ["get_wallet_balance (unknown account)", { address: `G${"A".repeat(55)}` }],
];

let failures = 0;
for (const [label, args] of checks) {
  const name = label.split(" ")[0];
  const expectError = label.includes("unknown");
  const result = await client.callTool({ name, arguments: args });
  const succeeded = summarize(label, result);
  if (succeeded === expectError) failures++;
}

// verify_user: a rejected token must come back as a normal result carrying
// `valid: false`, NOT as isError — that distinction is the tool's contract.
// Only the rejection path is exercised here; confirming a genuine token would
// require a real user credential, which this test deliberately does not handle.
const rejectedToken = await client.callTool({
  name: "verify_user",
  arguments: { access_token: "definitely-not-a-real-pi-access-token" },
});
const verdict = rejectedToken.structuredContent;
const contractHeld = rejectedToken.isError !== true && verdict?.valid === false;
summarize("verify_user (invalid token)", rejectedToken);
console.log(
  contractHeld
    ? "   ✓ reported valid:false as a result, not an error"
    : "   ✗ expected a non-error result with valid:false",
);
if (!contractHeld) failures++;

// The token must never be echoed back to the caller.
if (JSON.stringify(rejectedToken).includes("definitely-not-a-real")) {
  console.log("   ✗ token leaked into the tool result");
  failures++;
} else {
  console.log("   ✓ token not echoed in the result");
}

// Input validation is enforced by the schema, before any network call. The SDK
// may surface this either as a thrown McpError or as an isError result.
let rejected = false;
let detail = "";
try {
  const result = await client.callTool({
    name: "query_transaction",
    arguments: { hash: "not-a-hash" },
  });
  rejected = result.isError === true;
  detail = result.content?.[0]?.text ?? "";
} catch (err) {
  rejected = true;
  detail = err.message;
}
console.log(
  rejected
    ? `\n── input validation [ok] — malformed hash rejected: ${detail}`
    : "\n── input validation [ERROR] — malformed hash was accepted",
);
if (!rejected) failures++;

await client.close();
console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

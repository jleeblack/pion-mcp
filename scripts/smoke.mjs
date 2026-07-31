#!/usr/bin/env node
/**
 * End-to-end smoke test: spawns the built server over stdio as a real MCP
 * client, lists its tools, and exercises all three against live Pi testnet
 * Horizon. Requires network access. Run with `npm run smoke`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A funded Pi testnet account: the network's root/friendbot-style account is
// not stable across resets, so we discover a real account from the ledger.
const HORIZON = process.env.PION_HORIZON_URL ?? "https://api.testnet.minepi.com";

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
console.log(`Fixtures from ${HORIZON}:\n  address = ${address}\n  tx      = ${hash}`);

// Defaults to the local build; pass a path to test an installed copy instead,
// e.g. `node scripts/smoke.mjs ../somewhere/node_modules/pion-mcp/dist/index.js`
const entry = process.argv[2] ?? "dist/index.js";
console.log(`Server entry: ${entry}`);

const client = new Client({ name: "pion-smoke", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry] }));

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

#!/usr/bin/env node
/**
 * Calls send_payment once, deliberately.
 *
 * THIS MOVES FUNDS. It is the only script here that does.
 *
 * send_payment is an MCP tool, so the alternative is driving it through an
 * agent. For a first live spend that is the wrong instrument: an agent adds
 * nondeterminism to an irreversible action, and what you want is one payment,
 * with arguments you typed, that you can read the result of. This connects to
 * the server over stdio exactly as a real client would, calls the tool once,
 * and prints what came back.
 *
 * Refuses without --confirm, because a script is one up-arrow away from being
 * run twice, and a repeat send is a second payment for the same intent.
 *
 * Usage:
 *   node scripts/send.mjs <uid> <amount> --confirm
 *
 * Requires the server to be armed — PION_ENABLE_PAYMENTS=1, PION_MAX_PAYMENT_PI,
 * PI_SERVER_API_KEY, PI_WALLET_SECRET, testnet Horizon. If it is not, the tool
 * is not registered at all and this reports why.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { refuseSecretsInArgv } from "./guard-argv.mjs";

refuseSecretsInArgv();

const args = process.argv.slice(2);
const confirmed = args.includes("--confirm");
const [uid, amount] = args.filter((a) => !a.startsWith("--"));

if (!uid || !amount) {
  console.error("Usage: node scripts/send.mjs <uid> <amount> --confirm\n");
  console.error("  uid     recipient's app-scoped uid (verify_user returns it)");
  console.error("  amount  decimal Pi, e.g. 0.0000001");
  process.exit(1);
}

const HORIZON = process.env.PION_HORIZON_URL ?? "https://api.testnet.minepi.com";

console.log("About to send:\n");
console.log(`  amount   ${amount} Pi`);
console.log(`  to uid   ${uid}`);
console.log(`  horizon  ${HORIZON}`);
console.log(`  cap      ${process.env.PION_MAX_PAYMENT_PI ?? "(unset — server will refuse)"}`);
console.log("");

if (!confirmed) {
  console.error("Refusing without --confirm. THIS MOVES FUNDS and cannot be undone.");
  console.error("Re-run with --confirm appended once the values above are right.");
  process.exit(1);
}

const client = new Client({ name: "pion-send", version: "0.1.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    // Explicit: the transport does not forward the parent environment by
    // default, and every credential this needs lives there.
    env: { ...process.env },
  }),
);

const { tools } = await client.listTools();
if (!tools.some((t) => t.name === "send_payment")) {
  console.error("send_payment is NOT registered — the server is not armed.\n");
  console.error("Advertised tools:", tools.map((t) => t.name).join(", ") || "(none)");
  console.error("\nAll of these must hold:");
  console.error("  PION_ENABLE_PAYMENTS=1");
  console.error("  PION_MAX_PAYMENT_PI set to a positive amount");
  console.error("  PI_SERVER_API_KEY and PI_WALLET_SECRET both set");
  console.error("  Horizon pointing at testnet");
  await client.close();
  process.exit(1);
}

const result = await client.callTool({
  name: "send_payment",
  arguments: { uid, amount, memo: "Pion A2U first live send" },
});

console.log("=".repeat(60));
for (const block of result.content ?? []) {
  if (block.type === "text") console.log(block.text);
}
if (result.structuredContent) {
  console.log("\nStructured result:");
  console.log(JSON.stringify(result.structuredContent, null, 2));
}
console.log("=".repeat(60));

await client.close();
process.exitCode = result.isError ? 1 : 0;

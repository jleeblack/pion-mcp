#!/usr/bin/env node
/**
 * Reads one payment record from Pi and reports its terminal state.
 *
 * Read-only: creates nothing, cancels nothing, moves nothing.
 *
 * "Absent from incomplete_server_payments" and "in the correct final state"
 * are different facts. A recovery is only verified when both hold, so this
 * exists to check the second directly rather than inferring it from a list.
 *
 * Usage:
 *   node scripts/get-payment.mjs <paymentId>
 */
import { refuseSecretsInArgv } from "./guard-argv.mjs";
import { PLATFORM_URL, call, isPaymentId, requireApiKey, stateLine } from "./pi-api.mjs";

refuseSecretsInArgv();

const paymentId = process.argv[2];
if (!isPaymentId(paymentId)) {
  console.error("Usage: node scripts/get-payment.mjs <paymentId>");
  console.error("  paymentId: up to 64 characters of [A-Za-z0-9_-]");
  process.exit(1);
}

const key = requireApiKey();
console.log(`Platform: ${PLATFORM_URL}`);

const res = await call("GET", `/v2/payments/${paymentId}`, key);
if (!res.ok) {
  console.error(`\nLookup FAILED with HTTP ${res.status}.`);
  console.error(res.text.slice(0, 600) || "(empty body)");
  if (res.status === 404) {
    console.error("\nNo such payment for this app. Check the id, and that the key belongs");
    console.error("to the same Developer Portal app that created the payment.");
  }
  process.exitCode = 1;
} else {
  console.log("\nFull record:\n");
  console.log(JSON.stringify(res.json, null, 2));
  console.log("\n" + stateLine(res.json));
}

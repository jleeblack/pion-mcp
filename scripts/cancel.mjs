#!/usr/bin/env node
/**
 * Cancels a stranded payment record.
 *
 * The recovery for a payment that was created but never submitted on-chain:
 * it has no transaction, so it cannot be completed, and leaving it listed
 * blocks clean gate-1 checks and invites a duplicate send.
 *
 * Reads the record before cancelling and prints what it is about to act on —
 * the same read-before-write rule the U2A approve function follows. An id you
 * typed is still an id that can be mistyped.
 *
 * Does NOT move funds. Cancelling a payment whose transaction already landed
 * on-chain would not claw anything back; that case needs `complete`, not this.
 *
 * Usage:
 *   node scripts/cancel.mjs <paymentId>
 */
import { refuseSecretsInArgv } from "./guard-argv.mjs";
import { PLATFORM_URL, call, isPaymentId, requireApiKey, stateLine } from "./pi-api.mjs";

refuseSecretsInArgv();

const paymentId = process.argv[2];
if (!isPaymentId(paymentId)) {
  console.error("Usage: node scripts/cancel.mjs <paymentId>");
  process.exit(1);
}

const key = requireApiKey();
console.log(`Platform: ${PLATFORM_URL}`);

const before = await call("GET", `/v2/payments/${paymentId}`, key);
if (!before.ok) {
  console.error(`\nLookup FAILED with HTTP ${before.status}. Nothing was cancelled.`);
  console.error(before.text.slice(0, 600) || "(empty body)");
  process.exit(1);
}

console.log(`\nAbout to cancel:\n`);
console.log(`  amount ${before.json?.amount} Pi to uid ${before.json?.user_uid}`);
console.log(`  memo   ${JSON.stringify(before.json?.memo)}`);
console.log("");
console.log(stateLine(before.json));

if (before.json?.transaction?.txid) {
  console.error(
    "\nREFUSING: this payment has an on-chain transaction " +
      `(${before.json.transaction.txid}).\n` +
      "Cancelling would not reverse it — the recipient has been paid. Use\n" +
      "`npm run complete <paymentId> <txid>` to tell Pi the transaction landed.",
  );
  process.exit(1);
}

const res = await call("POST", `/v2/payments/${paymentId}/cancel`, key);
console.log("\n" + "=".repeat(60));
if (!res.ok) {
  console.error(`Cancel FAILED with HTTP ${res.status}.`);
  console.error(res.text.slice(0, 600) || "(empty body)");
  process.exitCode = 1;
} else {
  console.log("Cancel accepted. Record as Pi now reports it:\n");
  console.log(JSON.stringify(res.json, null, 2));
  console.log("\n" + stateLine(res.json));
  console.log("\nConfirm with: npm run get-payment " + paymentId);
}

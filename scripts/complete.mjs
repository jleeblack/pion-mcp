#!/usr/bin/env node
/**
 * Tells Pi that a payment's transaction landed on-chain.
 *
 * The recovery for the worst stranded case: funds left the wallet, the
 * blockchain accepted the transfer, and Pi was never notified — so its record
 * still says incomplete while the recipient has been paid.
 *
 * This moves no funds. It reconciles Pi's record with what the chain already
 * did, which is why it is safe to run and why retrying the *send* is not.
 *
 * Usage:
 *   node scripts/complete.mjs <paymentId> <txid>
 *
 * The txid comes from send_payment's failure report, or from Horizon.
 */
import { refuseSecretsInArgv } from "./guard-argv.mjs";
import { PLATFORM_URL, call, isPaymentId, isTxid, requireApiKey, stateLine } from "./pi-api.mjs";

refuseSecretsInArgv();

const [, , paymentId, txid] = process.argv;
if (!isPaymentId(paymentId) || !isTxid(txid)) {
  console.error("Usage: node scripts/complete.mjs <paymentId> <txid>");
  console.error("  paymentId: up to 64 characters of [A-Za-z0-9_-]");
  console.error("  txid:      the 64-hex transaction hash");
  process.exit(1);
}

const key = requireApiKey();
console.log(`Platform: ${PLATFORM_URL}`);

const before = await call("GET", `/v2/payments/${paymentId}`, key);
if (before.ok) {
  console.log("\nRecord before:\n");
  console.log(stateLine(before.json));
  if (before.json?.status?.developer_completed) {
    console.log("\nAlready completed — nothing to do.");
    process.exit(0);
  }
} else {
  console.error(`\nLookup returned HTTP ${before.status}; attempting complete anyway.`);
}

const res = await call("POST", `/v2/payments/${paymentId}/complete`, key, { txid });
console.log("\n" + "=".repeat(60));
if (!res.ok) {
  console.error(`Complete FAILED with HTTP ${res.status}.`);
  console.error(res.text.slice(0, 600) || "(empty body)");
  console.error(
    "\nThe funds have still moved. Do NOT re-send. Verify the txid against\n" +
      "Horizon and retry this command; a payment can stay incomplete on Pi's\n" +
      "side without the recipient being any less paid.",
  );
  process.exitCode = 1;
} else {
  console.log("Complete accepted. Record as Pi now reports it:\n");
  console.log(JSON.stringify(res.json, null, 2));
  console.log("\n" + stateLine(res.json));
  console.log("\nConfirm with: npm run get-payment " + paymentId);
}

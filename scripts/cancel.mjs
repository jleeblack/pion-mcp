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
import {
  PLATFORM_URL,
  call,
  findChainTransaction,
  isPaymentId,
  requireApiKey,
  stateLine,
} from "./pi-api.mjs";

/**
 * How old a record must be before "nothing on-chain" is trustworthy.
 *
 * Horizon ingests closed ledgers, so a just-submitted transaction is briefly
 * unqueryable. Five minutes is far beyond that window and costs nothing: the
 * only price of waiting is a record staying listed a little longer.
 */
const MIN_AGE_MS = 5 * 60 * 1000;

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

function refuse(lines) {
  console.error("\nREFUSING TO CANCEL.\n");
  for (const l of lines) console.error(l);
  process.exit(1);
}

if (before.json?.transaction?.txid) {
  refuse([
    `This payment has an on-chain transaction (${before.json.transaction.txid}).`,
    "Cancelling would not reverse it — the recipient has been paid.",
    `Use: npm run complete ${paymentId} ${before.json.transaction.txid}`,
  ]);
}

// Pi saying `transaction: null` is NOT evidence that nothing was sent — it only
// means Pi was never told. Drill B produced a record in exactly this state with
// the funds already delivered. The chain is the only source that can tell the
// two apart, so cancelling without asking it is how a recoverable strand
// becomes a silent loss.
const ageMs = Date.now() - new Date(before.json.created_at).getTime();
if (ageMs < MIN_AGE_MS) {
  const wait = Math.ceil((MIN_AGE_MS - ageMs) / 1000);
  refuse([
    `This payment is only ${Math.floor(ageMs / 1000)}s old.`,
    "",
    "A transaction submitted moments ago may not be queryable on Horizon yet, so",
    "a search now could report 'nothing on-chain' for a payment that has in fact",
    "been delivered — which is precisely the loss this check exists to prevent.",
    "",
    `Wait ${wait}s and re-run. Nothing was cancelled.`,
  ]);
}

console.log("\nSearching the chain for a transaction carrying this payment id…");
const chain = await findChainTransaction(
  before.json.from_address,
  before.json.identifier,
  before.json.created_at,
);

if (chain.inconclusive) {
  refuse([
    `The chain search was inconclusive: ${chain.reason}.`,
    "",
    "Refusing rather than assuming. An unnecessary refusal leaves a record listed;",
    "a wrong cancel loses funds the recipient already has. Resolve the Horizon",
    "problem and re-run.",
  ]);
}

if (chain.found) {
  refuse([
    "This payment WAS submitted on-chain — Pi simply never learned about it.",
    "",
    `  txid    ${chain.found.hash}`,
    `  ledger  ${chain.found.ledger}`,
    `  at      ${chain.found.created_at}`,
    "",
    "The recipient has been paid. Cancelling would strand that fact permanently.",
    `Use: npm run complete ${paymentId} ${chain.found.hash}`,
  ]);
}

console.log(
  chain.note
    ? `No transaction found (${chain.note}) — safe to cancel.`
    : "No transaction found on-chain — this payment was never submitted, safe to cancel.",
);

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

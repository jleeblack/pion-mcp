#!/usr/bin/env node
/**
 * Golden-XDR regression test for the A2U signing path.
 *
 * Rebuilds the exact transaction `send_payment` constructs — same builder,
 * same operation, same memo, same fee — with every input pinned, and asserts
 * the signed bytes still match the values recorded below. Nothing is submitted
 * and no network call is made; the keys are derived from fixed seeds and name
 * accounts that have never existed.
 *
 * ## Why this exists
 *
 * It was written during the @stellar/stellar-sdk 16.2.0 -> 17.0.0 review
 * (2026-08-28). v17 rewrote the entire XDR layer and switched public APIs from
 * Buffer to Uint8Array, and the release notes are explicit that several of the
 * resulting behaviour changes "fail silently" rather than as compile errors.
 * Our suites all passed on both versions — but every one of them stubs the
 * network, so none of them could tell us whether the bytes we sign had moved.
 *
 * Diffing the signed XDR across the two versions is what actually answered it:
 * byte-identical envelope, byte-identical transaction hash. That diff was the
 * review the situation needed, and this file is that diff turned into a
 * standing check.
 *
 * The v16 side cannot live in the tree once we are on v17 — only one version
 * is installed at a time — so the comparison is against committed constants
 * instead. Same guarantee, one version at a time: any future SDK bump that
 * changes what we put on the wire fails here, loudly, before it reaches a
 * payment.
 *
 * ## Maintaining it
 *
 * A failure means the SDK changed the bytes for identical inputs. That is a
 * finding, not a chore: do NOT refresh the constants to make it pass. Work out
 * which field moved and whether the new bytes are still a valid Pi payment,
 * then update these values deliberately, in the same commit, with the reason.
 *
 * Recorded under 16.2.0 and re-verified identical under 17.0.0.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Account, Asset, Keypair, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

// Cosmetic only — the goldens are the assertion. Never let a missing path
// turn a passing signing check into a crash.
let sdkVersion = "unknown version";
try {
  sdkVersion = JSON.parse(
    readFileSync(
      new URL("../node_modules/@stellar/stellar-sdk/package.json", import.meta.url),
      "utf8",
    ),
  ).version;
} catch {
  /* reported as "unknown version" below */
}

// ---- Pinned inputs. Every one of these must stay fixed for the goldens to ----
// ---- mean anything. Seeds rather than literal secrets so the keys are      ----
// ---- reproducible and obviously worthless.                                 ----
const SOURCE = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(7));
const DESTINATION = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(9)).publicKey();
const SEQUENCE = "103720918407103";
const FEE = "100000";
const AMOUNT = "1.2345678";
const NETWORK_PASSPHRASE = "Pi Testnet";
// 27 bytes — a real Pi payment identifier's shape, one under the memo limit.
const IDENTIFIER = "3f2504e0-4f89-11d3-9a0c-030";
// Fixed timebounds, because setTimeout() reads the clock and would make the
// envelope different on every run.
const TIMEBOUNDS = [0, 1893456000];

const GOLDEN = {
  publicKey: "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57",
  unsignedXdr:
    "AAAAAgAAAADqSmxj4pxSCr71UHsTLsX5lUd2rr6+e5JCHuppFEbSLAABhqAAAF5VaH9XwAAAAAEA" +
    "AAAAAAAAAAAAAABw29iAAAAAAQAAABszZjI1MDRlMC00Zjg5LTExZDMtOWEwYy0wMzAAAAAAAQAA" +
    "AAAAAAABAAAAAP0XJDhaoMdbZPt4zWAvodmR/ev3axPFjtcC6sg16fYYAAAAAAAAAAAAvGFOAAAA" +
    "AAAAAAA=",
  signedXdr:
    "AAAAAgAAAADqSmxj4pxSCr71UHsTLsX5lUd2rr6+e5JCHuppFEbSLAABhqAAAF5VaH9XwAAAAAEA" +
    "AAAAAAAAAAAAAABw29iAAAAAAQAAABszZjI1MDRlMC00Zjg5LTExZDMtOWEwYy0wMzAAAAAAAQAA" +
    "AAAAAAABAAAAAP0XJDhaoMdbZPt4zWAvodmR/ev3axPFjtcC6sg16fYYAAAAAAAAAAAAvGFOAAAA" +
    "AAAAAAEURtIsAAAAQCU0kmaoZPyBAJ+8Ax8qDmmIFYIfqDdQbwpmTQpWhdES5bcAUrrrqBsKzszK" +
    "yE2CFoMHgmalfCoK4jJTRlt9mA4=",
  txHashHex: "e007e4c8cfce670acf552eba7d5be8443e3198e0a8d92f1770c61524f370908e",
};

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message}`);
    failures++;
  }
}

/**
 * Serialises an envelope to base64 XDR.
 *
 * v17 collapsed acronyms in method names with no back-compat alias, so
 * `Transaction.toXDR()` became `toXdr()`. Accepting both keeps this file
 * runnable against an older SDK when a bump has to be bisected — which is
 * exactly the situation it exists for. Our own src/ never serialises XDR, so
 * the rename reaches nothing but this test.
 */
function toXdr(tx) {
  return typeof tx.toXdr === "function" ? tx.toXdr() : tx.toXDR();
}

/** Mirrors src/tools/send-payment.ts's construction exactly. */
function buildCanonicalTransaction() {
  return new TransactionBuilder(new Account(SOURCE.publicKey(), SEQUENCE), {
    fee: FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({ destination: DESTINATION, asset: Asset.native(), amount: AMOUNT }),
    )
    .addMemo(Memo.text(IDENTIFIER))
    .setTimebounds(...TIMEBOUNDS)
    .build();
}

console.log(`\n@stellar/stellar-sdk ${sdkVersion} — canonical A2U transaction:`);

const tx = buildCanonicalTransaction();
check("the source key derives from its seed unchanged", () =>
  assert.equal(SOURCE.publicKey(), GOLDEN.publicKey),
);
check("the unsigned envelope matches the recorded bytes", () =>
  assert.equal(toXdr(tx), GOLDEN.unsignedXdr),
);

tx.sign(SOURCE);
check("the signed envelope matches the recorded bytes", () =>
  assert.equal(toXdr(tx), GOLDEN.signedXdr),
);
check("exactly one signature is attached", () => assert.equal(tx.signatures.length, 1));
// Buffer.from() accepts a Uint8Array, so this is the hex recipe that survives
// v17's Buffer -> Uint8Array switch. A bare String(tx.hash()) would silently
// produce comma-joined decimals instead — the failure mode this file guards.
check("the transaction hash matches the recorded digest", () =>
  assert.equal(Buffer.from(tx.hash()).toString("hex"), GOLDEN.txHashHex),
);

console.log("\nSDK contract the payment path depends on:");

check("publicKey() is a string our address regex accepts", () =>
  assert.match(SOURCE.publicKey(), /^G[A-Z2-7]{55}$/),
);
check("secret() is a string our seed regex accepts", () =>
  assert.match(SOURCE.secret(), /^S[A-Z2-7]{55}$/),
);
// send_payment refuses at 29+ bytes before signing, using Buffer.byteLength.
// If the SDK's own limit ever moved, that pre-flight check would stop agreeing
// with the thing it is protecting.
check("Memo.text accepts exactly 28 bytes", () => assert.equal(Memo.text("a".repeat(28)).type, "text"));
check("Memo.text rejects 29 bytes", () => assert.throws(() => Memo.text("a".repeat(29))));
check("the memo limit counts bytes, not characters", () => {
  assert.equal(Memo.text("é".repeat(14)).type, "text"); // 28 bytes
  assert.throws(() => Memo.text("é".repeat(15))); // 30 bytes
});
// Our pre-flight uses Buffer.byteLength on the identifier; these must agree.
check("Buffer.byteLength agrees with the SDK on the boundary", () => {
  assert.equal(Buffer.byteLength("é".repeat(14), "utf8"), 28);
  assert.equal(Buffer.byteLength(IDENTIFIER, "utf8"), 27);
});

if (failures > 0) {
  console.error(
    `\n${failures} check(s) failed. The SDK changed what we sign for identical inputs.\n` +
      "Do not refresh the constants to make this pass — find out which field moved.\n",
  );
  process.exit(1);
}
console.log("\nSigning path unchanged. Safe to bump.\n");

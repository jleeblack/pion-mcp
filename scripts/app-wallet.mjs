#!/usr/bin/env node
/**
 * Reports the app wallet's address and whether it is funded.
 *
 * A2U spends from the APP wallet — the one attached to your app in the
 * Developer Portal — not from your personal Pi Browser wallet. A freshly
 * created app wallet has never been funded, and on Stellar an unfunded
 * account does not exist on-chain at all: a payment from it fails at submit,
 * *after* the Pi payment record is created, which is the stranded case worth
 * avoiding.
 *
 * Reads PI_WALLET_SECRET, derives the public key, and queries Horizon. The
 * secret is never printed; the public key is public by definition.
 *
 * Usage:
 *   $env:PI_WALLET_SECRET = Read-Host "Wallet secret"   # keeps it out of history
 *   node scripts/app-wallet.mjs
 */
import { Keypair } from "@stellar/stellar-sdk";

const HORIZON_URL = (process.env.PION_HORIZON_URL ?? "https://api.testnet.minepi.com").replace(
  /\/+$/,
  "",
);

const secret = process.env.PI_WALLET_SECRET;
if (!secret) {
  // Distinguish "never set" from "set but empty" — the second happens when a
  // Read-Host prompt is submitted before the paste registers, and reporting
  // it as unset sends you looking in the wrong place.
  console.error(
    secret === ""
      ? "PI_WALLET_SECRET is set but empty — the prompt was submitted with nothing in it.\n"
      : "PI_WALLET_SECRET is not set in this shell.\n",
  );
  console.error("Set it without leaving the value in PowerShell history:");
  console.error('  $env:PI_WALLET_SECRET = Read-Host "Wallet secret"');
  console.error("\nPaste at the prompt, then press Enter. Confirm with:");
  console.error("  $env:PI_WALLET_SECRET.Length     # expect 56");
  process.exit(1);
}

let publicKey;
const trimmed = secret.trim();
try {
  publicKey = Keypair.fromSecret(trimmed).publicKey();
} catch {
  // Report the *shape* of what was supplied, never the value itself. The
  // leading character and length are enough to identify every common mistake.
  const first = trimmed[0];
  console.error("PI_WALLET_SECRET is not a valid Stellar secret seed.\n");
  console.error(`  Length: ${trimmed.length} (expected 56)`);
  console.error(`  Starts with: ${first ?? "(empty)"} (expected S)\n`);

  if (first === "G") {
    console.error("That is a PUBLIC key, not the secret — both are 56 characters, so");
    console.error("length alone will not catch the mix-up. In the Developer Portal the");
    console.error("public key is the address shown; the secret is the separate value you");
    console.error("must reveal explicitly.");
  } else if (first === "S" && trimmed.length === 56) {
    console.error("Right shape, but the checksum fails — a character is wrong or the");
    console.error("paste picked up a lookalike. Re-copy it directly from the portal.");
  } else if (trimmed.split(/\s+/).length > 1) {
    console.error("That looks like a mnemonic phrase rather than a raw seed. Pion needs");
    console.error("the S... secret key. If the portal only offers a recovery phrase, say");
    console.error("so — deriving a keypair from it is extra work Pion does not do yet.");
  } else {
    console.error("Unrecognised format. Pion expects a raw Stellar secret seed (S...).");
  }
  process.exit(1);
}

console.log(`Horizon:    ${HORIZON_URL}`);
console.log(`App wallet: ${publicKey}\n`);

const res = await fetch(`${HORIZON_URL}/accounts/${publicKey}`, {
  headers: { accept: "application/json" },
});

if (res.status === 404) {
  console.log("NOT FUNDED — this account does not exist on-chain yet.\n");
  console.log("On Stellar an account only exists once it has received a starting balance,");
  console.log("so a payment from it would fail at submit, after the Pi payment record is");
  console.log("created. Fund it before sending anything:\n");
  console.log(`  1. Open the Pi Developer Portal and use the testnet faucet for this app, or`);
  console.log(`  2. Send test-Pi from your personal testnet wallet to:`);
  console.log(`     ${publicKey}\n`);
  process.exitCode = 1;
} else if (!res.ok) {
  console.error(`Horizon returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exitCode = 1;
} else {
  const account = await res.json();
  console.log("FUNDED. Balances:\n");
  for (const b of account.balances) {
    const asset =
      b.asset_type === "native" ? "PI" : b.asset_code ? `${b.asset_code}:${b.asset_issuer}` : b.asset_type;
    console.log(`  ${b.balance.padStart(20)}  ${asset}`);
  }
  const native = account.balances.find((b) => b.asset_type === "native");
  console.log(
    `\nSpendable Pi: ${native?.balance ?? "0"} (minus ~1 Pi reserve and per-tx fees)`,
  );
  console.log("\nReady for an A2U send, provided the memo probe passes.");
}

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
try {
  publicKey = Keypair.fromSecret(secret.trim()).publicKey();
} catch {
  // Never echo the value, even partially.
  console.error("PI_WALLET_SECRET is not a valid Stellar secret seed.");
  console.error("Expected 56 characters beginning with S. Check for a truncated paste.");
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

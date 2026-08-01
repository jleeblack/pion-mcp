#!/usr/bin/env node
/**
 * Diagnoses a `missing_scope` failure on A2U create when /v2/me says the
 * scope *is* granted. Read-only: creates nothing, moves nothing.
 *
 * The contradiction has two plausible causes and they need different fixes:
 *
 *   A. The server API key and the OAuth client belong to DIFFERENT apps.
 *      Pi uids are app-specific, so a uid minted for app X is meaningless to
 *      app Y, and Y reports no grant for it. Fix: use matching credentials.
 *
 *   B. Same app, but a wallet_address grant obtained through Pi Sign-in is
 *      not honoured for Platform API payments — consistent with the known
 *      split where identity flows out of the Pi Browser but payment
 *      authorization does not. Fix: authorize via the Pi Browser SDK.
 *
 * Usage:
 *   PI_SERVER_API_KEY=... node scripts/diagnose-a2u.mjs <uid> [expected-app-id]
 */
import { refuseSecretsInArgv } from "./guard-argv.mjs";

refuseSecretsInArgv();

const PLATFORM_URL = (process.env.PION_PLATFORM_URL ?? "https://api.minepi.com").replace(
  /\/+$/,
  "",
);

const apiKey = process.env.PI_SERVER_API_KEY;
const uid = process.argv[2];
const expectedAppId = process.argv[3];

if (!apiKey || !uid) {
  console.error("Usage: PI_SERVER_API_KEY=... node scripts/diagnose-a2u.mjs <uid> [app-id]");
  console.error("The app-id is the `app_id` from your /v2/me response.");
  process.exit(1);
}

async function call(path) {
  const res = await fetch(`${PLATFORM_URL}${path}`, {
    headers: { authorization: `Key ${apiKey}`, accept: "application/json" },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, ok: res.ok, json, text };
}

console.log(`Platform: ${PLATFORM_URL}\n`);

// 1. Prove the server API key is valid and usable on its own. This endpoint
//    needs only the key — no user consent — so it isolates key validity from
//    the scope question entirely.
console.log("1. Checking the server API key against an endpoint that needs no user consent…");
const incomplete = await call("/v2/payments/incomplete_server_payments");

if (incomplete.status === 401 && incomplete.json?.error !== "missing_scope") {
  console.log("   ✗ The server API key itself is rejected.");
  console.log(`     ${incomplete.text.slice(0, 200)}`);
  console.log("\n   => The key is wrong or belongs to no app. Re-copy it from the portal.");
  process.exitCode = 1;
} else if (incomplete.ok) {
  console.log("   ✓ Key is valid and accepted.");
  const payments = incomplete.json?.incomplete_server_payments;
  if (Array.isArray(payments)) {
    console.log(`   Incomplete server payments: ${payments.length}`);
    // Any payment carries the owning app id — the cheapest ground truth
    // available for which app this key actually belongs to.
    const seen = [...new Set(payments.map((p) => p?.app_id).filter(Boolean))];
    if (seen.length > 0) {
      console.log(`   App id(s) seen on this key's payments: ${seen.join(", ")}`);
      if (expectedAppId) {
        console.log(
          seen.includes(expectedAppId)
            ? `   ✓ Matches your token's app_id (${expectedAppId}).`
            : `   ✗ Does NOT match your token's app_id (${expectedAppId}) — cause A.`,
        );
      }
    } else {
      console.log("   (No prior payments, so the app id cannot be read from here.)");
    }
  }
} else {
  console.log(`   ? Unexpected ${incomplete.status}: ${incomplete.text.slice(0, 200)}`);
}

console.log("\n" + "=".repeat(60));
console.log("WHAT TO CHECK NEXT");
console.log("=".repeat(60));
console.log(`
Your token's app_id: ${expectedAppId ?? "(not supplied — pass it as the 2nd argument)"}
Recipient uid:       ${uid}

In the Pi Developer Portal, open the app that issued your SERVER API KEY and
compare its app id to the app_id above.

  If they DIFFER  -> cause A. The uid belongs to the other app and is
                     meaningless to this one. Use the OAuth client ID and the
                     server API key from the SAME app, then re-run sign-in so
                     the uid is minted for that app.

  If they MATCH   -> cause B. The wallet_address grant from Pi Sign-in is not
                     being honoured for Platform API payments. Open your app
                     inside the Pi Browser and authenticate there
                     (Pi.authenticate with the wallet_address scope), which
                     records the grant through the Browser SDK path, then
                     re-run the probe.

Neither cause is a bug in Pion, and nothing here has moved funds.
`);

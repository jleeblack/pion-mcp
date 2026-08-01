#!/usr/bin/env node
/**
 * Works out whether the server API key belongs to the same app that issued
 * your uid — without needing the portal to display a raw app id.
 *
 * The trick is a differential test. We attempt create twice: once with your
 * real uid, once with a random UUID that is certainly not a user of any app.
 *
 *   Different errors -> the app DISTINGUISHES your uid from an unknown one,
 *                       so it knows the user. Same app. The failure is
 *                       therefore about which grant record A2U reads, not
 *                       about app identity.
 *
 *   Same error       -> missing_scope is just the generic "cannot resolve a
 *                       wallet" answer and says nothing about app identity;
 *                       falls back to endpoint probing below.
 *
 * Every create attempt here is expected to FAIL. Nothing is created and no
 * funds move. PI_WALLET_SECRET is never read.
 *
 * Usage:
 *   PI_SERVER_API_KEY=... node scripts/identify-app.mjs <your-uid>
 */
import { refuseSecretsInArgv } from "./guard-argv.mjs";

refuseSecretsInArgv();

import { randomUUID } from "node:crypto";

const PLATFORM_URL = (process.env.PION_PLATFORM_URL ?? "https://api.minepi.com").replace(
  /\/+$/,
  "",
);

const apiKey = process.env.PI_SERVER_API_KEY;
const realUid = process.argv[2];
if (!apiKey || !realUid) {
  console.error("Usage: PI_SERVER_API_KEY=... node scripts/identify-app.mjs <your-uid>");
  process.exit(1);
}

async function req(method, path, body) {
  const res = await fetch(`${PLATFORM_URL}${path}`, {
    method,
    headers: {
      authorization: `Key ${apiKey}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 300) };
}

const attempt = (uid) =>
  req("POST", "/v2/payments", {
    payment: { amount: 0.0000001, memo: "pion identity probe", metadata: {}, uid },
  });

console.log(`Platform: ${PLATFORM_URL}\n`);
console.log("Differential test — both attempts are expected to fail.\n");

const bogusUid = randomUUID();
const [mine, bogus] = await Promise.all([attempt(realUid), attempt(bogusUid)]);

// `a ?? b || c` is a SyntaxError — the grouping has to be explicit.
const describe = (r) => `${r.status} ${r.json?.error ?? (r.text || "(empty)")}`;

console.log(`  your uid  (${realUid})`);
console.log(`    -> ${describe(mine)}`);
if (mine.json?.error_message) console.log(`       ${mine.json.error_message}`);
console.log(`\n  random uid (${bogusUid})`);
console.log(`    -> ${describe(bogus)}`);
if (bogus.json?.error_message) console.log(`       ${bogus.json.error_message}`);

// If either unexpectedly succeeded, clean it up rather than leaving a record.
for (const [label, r] of [
  ["your uid", mine],
  ["random uid", bogus],
]) {
  const id = r.json?.identifier;
  if (r.ok && id) {
    console.log(`\n!! Create SUCCEEDED for ${label} (id ${id}) — cancelling it now.`);
    const c = await req("POST", `/v2/payments/${id}/cancel`);
    console.log(c.ok ? "   cancelled." : `   COULD NOT CANCEL: ${c.text}`);
    console.log(`   Identifier length: ${Buffer.byteLength(id, "utf8")} bytes (memo limit 28)`);
  }
}

console.log("\n" + "=".repeat(60));
console.log("VERDICT");
console.log("=".repeat(60));

const sameError =
  mine.status === bogus.status && (mine.json?.error ?? mine.text) === (bogus.json?.error ?? bogus.text);

if (mine.ok) {
  console.log(`
Your uid WORKS for this key — the earlier failure is resolved. Re-run:
  node scripts/probe-a2u.mjs ${realUid}
`);
} else if (!sameError) {
  console.log(`
The app responds DIFFERENTLY to your uid than to a random one, so it
recognises your uid as one of its users. The server API key and the OAuth
client are therefore the same app, and app identity is NOT the problem.

That leaves the grant-path explanation: a wallet_address grant obtained
through Pi Sign-in is not the grant A2U reads. Authorize through the Pi
Browser SDK instead:

  node scripts/browser-auth/serve.mjs

then open the printed URL inside the Pi Browser and approve.
`);
} else {
  console.log(`
Both uids produce the identical error, so "missing_scope" is this API's
generic "cannot resolve a wallet" answer and reveals nothing about app
identity. It does NOT confirm the key belongs to another app.

Try the Pi Browser authorization path, which is the remaining explanation:

  node scripts/browser-auth/serve.mjs

If that also fails, the credentials are worth re-issuing from a single app.
`);
}
console.log("No payment records were left behind and no funds moved.");

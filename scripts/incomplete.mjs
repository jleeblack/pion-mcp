#!/usr/bin/env node
/**
 * Lists this app's incomplete server payments.
 *
 * `GET /v2/payments/incomplete_server_payments` is Pi's own answer to "did I
 * leave anything dangling?" — the authoritative check, as opposed to trusting
 * that an earlier cancel returned 200. Run it before arming a real send: a
 * lingering record means a retry would create a second payment for the same
 * intent, and A2U failures strand records rather than losing funds.
 *
 * Read-only. Creates nothing, cancels nothing, moves nothing.
 *
 * Usage:
 *   $env:PI_SERVER_API_KEY = Read-Host "Server API key"
 *   node scripts/incomplete.mjs
 */
import { refuseSecretsInArgv } from "./guard-argv.mjs";

refuseSecretsInArgv();

const PLATFORM_URL = (process.env.PION_PLATFORM_URL ?? "https://api.minepi.com").replace(
  /\/+$/,
  "",
);

const apiKey = process.env.PI_SERVER_API_KEY;
if (!apiKey) {
  console.error("PI_SERVER_API_KEY is not set in this shell.\n");
  console.error("Set it without leaving the value in PowerShell history:");
  console.error('  $env:PI_SERVER_API_KEY = Read-Host "Server API key"');
  process.exit(1);
}

const res = await fetch(`${PLATFORM_URL}/v2/payments/incomplete_server_payments`, {
  headers: { authorization: `Key ${apiKey}`, accept: "application/json" },
});

const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = undefined;
}

if (!res.ok) {
  console.error(`Request FAILED with HTTP ${res.status}.`);
  console.error(text.slice(0, 600) || "(empty body)");
  if (res.status === 401 || res.status === 403) {
    console.error("\nThe server API key was rejected, or belongs to a different app.");
  }
  process.exitCode = 1;
} else {
  // Pi wraps the list; tolerate either shape rather than assuming one, since
  // guessing a field name is what stranded send_payment for a whole build.
  const payments = Array.isArray(body)
    ? body
    : Array.isArray(body?.incomplete_server_payments)
      ? body.incomplete_server_payments
      : null;

  if (payments === null) {
    console.log("Unrecognized response shape — showing it verbatim:\n");
    console.log(JSON.stringify(body ?? text, null, 2));
  } else if (payments.length === 0) {
    console.log("✓ No incomplete server payments. Nothing is lingering.");
  } else {
    console.log(`⚠ ${payments.length} incomplete server payment(s):\n`);
    console.log(JSON.stringify(payments, null, 2));
    console.log(
      "\nResolve each before sending again. A record with a transaction can be\n" +
        "completed (POST /v2/payments/{id}/complete with its txid); one without\n" +
        "was never submitted on-chain and should be cancelled\n" +
        "(POST /v2/payments/{id}/cancel).",
    );
  }
}

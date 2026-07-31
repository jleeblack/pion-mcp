#!/usr/bin/env node
/**
 * Answers the open A2U design questions WITHOUT moving funds.
 *
 * It creates a payment record with Pi, inspects the response, then cancels it.
 * No transaction is built, nothing is signed, and PI_WALLET_SECRET is never
 * read — this script cannot spend, by construction.
 *
 * What it answers:
 *   1. How long is a Pi payment identifier? A2U requires it as a Stellar text
 *      memo, which is capped at 28 bytes. If it overflows, send_payment's
 *      memo approach needs rethinking rather than patching.
 *   2. Does the create response include the recipient wallet address, as
 *      send_payment assumes, or is a separate lookup required?
 *
 * Usage:
 *   PI_SERVER_API_KEY=... node scripts/probe-a2u.mjs <recipient-uid>
 *
 * The uid must be a real one from your app (verify_user returns it). Pi
 * validates it, so a made-up value will be rejected at create.
 */
const PLATFORM_URL = (
  process.env.PION_PLATFORM_URL ?? "https://api.minepi.com"
).replace(/\/+$/, "");
const MAX_MEMO_BYTES = 28;
const PROBE_AMOUNT = 0.0000001; // smallest representable; never actually sent

const apiKey = process.env.PI_SERVER_API_KEY;
const uid = process.argv[2];

if (!apiKey) {
  console.error(
    "PI_SERVER_API_KEY is not set. Export it in your shell and re-run.",
  );
  console.error(
    "Do NOT pass it as an argument — it would land in your shell history.",
  );
  process.exit(1);
}
if (!uid) {
  console.error(
    "Usage: PI_SERVER_API_KEY=... node scripts/probe-a2u.mjs <recipient-uid>",
  );
  console.error(
    "The uid must be a real app-scoped uid, as returned by verify_user.",
  );
  process.exit(1);
}
if (process.env.PI_WALLET_SECRET) {
  console.error(
    "Note: PI_WALLET_SECRET is set but will NOT be read. This probe cannot spend.\n",
  );
}

async function call(method, path, body) {
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
  return { status: res.status, ok: res.ok, json, text };
}

async function main() {
  console.log(`Platform: ${PLATFORM_URL}`);
  console.log(
    `Creating a probe payment of ${PROBE_AMOUNT} Pi to uid ${uid} …\n`,
  );

  const created = await call("POST", "/v2/payments", {
    payment: {
      amount: PROBE_AMOUNT,
      memo: "pion probe - will be cancelled",
      metadata: { probe: true },
      uid,
    },
  });

  if (!created.ok) {
    console.error(`Create FAILED with HTTP ${created.status}.`);
    console.error(created.text.slice(0, 600) || "(empty body)");
    console.error("\nNothing was created and nothing needs cleaning up.");
    // A 401 here is ambiguous: it can mean a bad key OR that the recipient
    // has not granted a scope. The body says which — read it, don't guess.
    const apiError = created.json?.error;
    if (apiError === "missing_scope") {
      console.error(
        "\nThis is a CONSENT problem, not a credential problem.\n" +
          "Your API key is fine. The recipient has not authorized the wallet_address\n" +
          "scope for your app, so Pi will not resolve their wallet.\n\n" +
          "The verified route is a Pi Browser SDK grant: have the recipient open the\n" +
          "app in the Pi Browser and authenticate with wallet_address among the\n" +
          "requested scopes — site/pay.html and scripts/browser-auth/index.html both\n" +
          "do this. Then re-run this probe with the same uid.\n\n" +
          "Whether a Pi Sign-in grant (scripts/pi-signin.mjs) also satisfies A2U is an\n" +
          "open question — untested in both directions. If you try it, record the result.",
      );
    } else if (created.status === 401 || created.status === 403) {
      console.error("The server API key was rejected.");
    } else if (created.status === 400) {
      console.error(
        "A 400 here usually means the uid is not a valid user of this app.",
      );
    }
    // Set the code rather than exiting outright: forcing exit while a fetch
    // handle is still settling trips a libuv assertion on Windows.
    process.exitCode = 1;
    return;
  }

  const payment = created.json ?? {};
  const identifier = payment.identifier;

  console.log("Create succeeded. Full response:\n");
  console.log(JSON.stringify(payment, null, 2));
  console.log("\n" + "=".repeat(60));
  console.log("ANSWERS");
  console.log("=".repeat(60));

  if (typeof identifier === "string") {
    const bytes = Buffer.byteLength(identifier, "utf8");
    console.log(`\n1. Payment identifier: "${identifier}"`);
    console.log(
      `   Length: ${bytes} bytes (Stellar text memo limit is ${MAX_MEMO_BYTES})`,
    );
    console.log(
      bytes <= MAX_MEMO_BYTES
        ? "   ✓ FITS — send_payment's memo approach works as written."
        : "   ✗ TOO LONG — the memo approach cannot work. send_payment will refuse\n" +
            "     before signing, but the design needs revisiting.",
    );
  } else {
    console.log(
      "\n1. No `identifier` field on the response — check the payload above.",
    );
  }

  const recipient = payment.recipient;
  console.log(
    `\n2. Recipient address on create response: ${recipient ?? "(absent)"}`,
  );
  console.log(
    typeof recipient === "string" && /^G[A-Z2-7]{55}$/.test(recipient)
      ? "   ✓ Present and well-formed — send_payment's assumption holds."
      : "   ✗ Missing or malformed — send_payment needs a separate lookup step.",
  );

  // Clean up. Leaving the record would show up as an incomplete payment.
  console.log("\n" + "=".repeat(60));
  if (typeof identifier === "string") {
    const cancelled = await call("POST", `/v2/payments/${identifier}/cancel`);
    console.log(
      cancelled.ok
        ? `Probe payment ${identifier} cancelled. Nothing outstanding.`
        : `WARNING: could not cancel ${identifier} (HTTP ${cancelled.status}).\n` +
            `${cancelled.text.slice(0, 300)}\n` +
            "Cancel it manually so it does not linger as an incomplete payment.",
    );
  }
  console.log("No funds moved at any point.");
}

await main();

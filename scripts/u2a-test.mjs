#!/usr/bin/env node
/**
 * Verifies the U2A payment functions in netlify/functions/.
 *
 * These functions are the server half of a flow whose client half is hostile by
 * assumption (docs/pi-sdk-notes.md): the browser sends a payment id, and the
 * server decides what that is worth. The checks that make that safe — refusing
 * a payment that is not the one we offered, refusing an id that could escape
 * its URL path, and never reporting a payment as completed on anything but a
 * 200 — are tested here rather than only through a live payment.
 *
 * Nothing here touches the real Pi API. PION_PLATFORM_URL is pointed at a local
 * stub before the handlers are imported, so every call lands on a socket this
 * script owns, and the API key is a fake.
 *
 * Usage: npm run u2a
 */
import assert from "node:assert/strict";
import http from "node:http";

// Scripted responses for the stub, keyed by "METHOD /path".
let script = {};
// Every request the handlers actually made, so a test can assert on calls that
// should NOT have happened.
let seen = [];

const server = http.createServer((req, res) => {
  seen.push({ call: `${req.method} ${req.url}`, auth: req.headers.authorization });
  const hit = script[`${req.method} ${req.url}`] ?? {
    status: 500,
    body: { error: "unscripted_request" },
  };
  res.writeHead(hit.status, { "content-type": "application/json" });
  res.end(JSON.stringify(hit.body));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

// Must be set before the handlers are imported: they read the base URL and the
// key at module load.
process.env.PION_PLATFORM_URL = `http://127.0.0.1:${server.address().port}`;
process.env.PI_SERVER_API_KEY = "fake-key-for-function-testing";

const { default: approve } = await import("../netlify/functions/approve.mjs");
const { default: complete } = await import("../netlify/functions/complete.mjs");

const post = (body) =>
  new Request("http://site/.netlify/functions/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** The payment this page is allowed to handle. */
const GOOD = { identifier: "pay1", amount: 0.314, memo: "Pion setup test", status: {} };
const TXID = "a".repeat(64);

const results = [];
async function check(name, fn) {
  script = {};
  seen = [];
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL ${name}\n       ${err.message.split("\n")[0]}`);
  }
}

console.log("approve:");

await check("approves the expected payment and authenticates as the app", async () => {
  script = {
    "GET /v2/payments/pay1": { status: 200, body: GOOD },
    "POST /v2/payments/pay1/approve": {
      status: 200,
      body: { ...GOOD, status: { developer_approved: true } },
    },
  };
  const res = await approve(post({ paymentId: "pay1" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    approved: true,
    paymentId: "pay1",
    status: { developer_approved: true },
  });
  assert.equal(seen[0].auth, "Key fake-key-for-function-testing");
});

await check("refuses a real id that is not the payment we offered", async () => {
  // The hostile case: the id exists and belongs to this app, but the payment is
  // for 500 Pi. Approving on the strength of the id alone would authorize it.
  script = { "GET /v2/payments/pay2": { status: 200, body: { ...GOOD, amount: 500 } } };
  const res = await approve(post({ paymentId: "pay2" }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "unexpected_payment");
  assert.equal(seen.length, 1, "/approve must not be called after a refusal");
});

await check("refuses a payment whose memo does not match", async () => {
  script = { "GET /v2/payments/pay3": { status: 200, body: { ...GOOD, memo: "something else" } } };
  const res = await approve(post({ paymentId: "pay3" }));
  assert.equal(res.status, 409);
  assert.equal(seen.length, 1);
});

await check("refuses an already-cancelled payment", async () => {
  script = {
    "GET /v2/payments/pay4": { status: 200, body: { ...GOOD, status: { cancelled: true } } },
  };
  assert.equal((await approve(post({ paymentId: "pay4" }))).status, 409);
  assert.equal(seen.length, 1);
});

await check("rejects an id that would escape its URL path, before any call", async () => {
  const res = await approve(post({ paymentId: "pay1/../../../v2/me" }));
  assert.equal(res.status, 400);
  assert.equal(seen.length, 0, "a malformed id must never reach the network");
});

await check("rejects a missing or non-string id", async () => {
  assert.equal((await approve(post({}))).status, 400);
  assert.equal((await approve(post({ paymentId: 42 }))).status, 400);
  assert.equal(seen.length, 0);
});

console.log("complete:");

await check("reports completed only on a 200 from Pi", async () => {
  script = {
    "POST /v2/payments/pay1/complete": {
      status: 200,
      body: {
        ...GOOD,
        status: { developer_completed: true },
        transaction: { txid: TXID, verified: true },
      },
    },
  };
  const res = await complete(post({ paymentId: "pay1", txid: TXID }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.completed, true);
  assert.equal(body.verified, true);
});

await check("never reports completed when Pi refuses", async () => {
  script = { "POST /v2/payments/pay1/complete": { status: 400, body: { error: "invalid_txid" } } };
  const res = await complete(post({ paymentId: "pay1", txid: TXID }));
  assert.equal(res.status, 400);
  assert.notEqual((await res.json()).completed, true);
});

await check("answers a missing txid locally instead of forwarding it", async () => {
  // What onIncompletePaymentFound sends for a payment that never reached the
  // chain. It cannot be completed, and saying so beats a Pi error the page
  // cannot interpret.
  const res = await complete(post({ paymentId: "pay1" }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "missing_txid");
  assert.equal(seen.length, 0);
});

console.log("error mapping:");

await check("passes through a status that is about the payment", async () => {
  script = { "GET /v2/payments/nope": { status: 404, body: { error: "payment_not_found" } } };
  assert.equal((await approve(post({ paymentId: "nope" }))).status, 404);
});

await check("reports our own failures as 502, not as the caller's fault", async () => {
  for (const status of [401, 403, 500, 503]) {
    script = { "GET /v2/payments/pay1": { status, body: { error: "upstream" } } };
    const res = await approve(post({ paymentId: "pay1" }));
    assert.equal(res.status, 502, `upstream ${status} should map to 502`);
  }
});

await check("refuses to act at all without a server API key", async () => {
  const saved = process.env.PI_SERVER_API_KEY;
  try {
    delete process.env.PI_SERVER_API_KEY;
    const res = await approve(post({ paymentId: "pay1" }));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "not_configured");
    assert.equal(seen.length, 0);
  } finally {
    process.env.PI_SERVER_API_KEY = saved;
  }
});

await check("rejects a method or body it cannot trust", async () => {
  const get = new Request("http://site/.netlify/functions/x");
  assert.equal((await approve(get)).status, 405);
  const bad = new Request("http://site/.netlify/functions/x", { method: "POST", body: "not json" });
  assert.equal((await approve(bad)).status, 400);
  assert.equal(seen.length, 0);
});

// Last, because it works by taking the stub away. The handlers captured the
// base URL at import, so closing the listener is the honest way to produce a
// connection failure — swapping PION_PLATFORM_URL now would not reach them.
await new Promise((resolve) => server.close(resolve));

await check("reports an unreachable Platform API as 502", async () => {
  const res = await approve(post({ paymentId: "pay1" }));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.upstreamStatus, null);
  assert.match(body.message, /Could not reach|did not respond/);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  for (const f of failed) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Verifies the Tier C arming guards and the spend cap.
 *
 * These are the controls that bound worst-case loss, so they are tested
 * directly rather than only through a live payment. No real credentials are
 * used and nothing here can move funds: the fake secret is a syntactically
 * valid Stellar seed for an account that does not exist.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Keypair } from "@stellar/stellar-sdk";

import { checkPaymentsArming, toStroops } from "../dist/payments.js";

// Generated fresh, never funded, never used. Valid shape, worthless.
const THROWAWAY_SECRET = Keypair.random().secret();

const ARMED = {
  PION_ENABLE_PAYMENTS: "1",
  PI_SERVER_API_KEY: "fake-key-for-guard-testing",
  PI_WALLET_SECRET: THROWAWAY_SECRET,
  PION_MAX_PAYMENT_PI: "10",
};
const TESTNET = "https://api.testnet.minepi.com";

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

/** Runs checkPaymentsArming with a patched environment, then restores it. */
function withEnv(overrides, horizon, fn) {
  const saved = { ...process.env };
  for (const key of Object.keys(ARMED)) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn(checkPaymentsArming(horizon));
  } finally {
    process.env = saved;
  }
}

console.log("\nArming guards — each must refuse for its own specific reason:");

check("disarmed by default (no env at all)", () =>
  withEnv({}, TESTNET, (r) => {
    assert.equal(r.armed, false);
    assert.match(r.reason, /PION_ENABLE_PAYMENTS/);
  }),
);

check("credentials alone do NOT arm it", () =>
  withEnv(
    { PI_SERVER_API_KEY: ARMED.PI_SERVER_API_KEY, PI_WALLET_SECRET: THROWAWAY_SECRET },
    TESTNET,
    (r) => {
      assert.equal(r.armed, false, "credentials without the switch must not arm");
      assert.match(r.reason, /PION_ENABLE_PAYMENTS/);
    },
  ),
);

check("refuses non-testnet Horizon even when fully configured", () =>
  withEnv(ARMED, "https://api.mainnet.minepi.com", (r) => {
    assert.equal(r.armed, false);
    assert.match(r.reason, /not testnet/);
  }),
);

check("missing server API key refuses", () =>
  withEnv({ ...ARMED, PI_SERVER_API_KEY: undefined }, TESTNET, (r) => {
    assert.equal(r.armed, false);
    assert.match(r.reason, /PI_SERVER_API_KEY/);
  }),
);

check("malformed wallet secret refuses without echoing the value", () =>
  withEnv({ ...ARMED, PI_WALLET_SECRET: "SNOTAREALSECRET" }, TESTNET, (r) => {
    assert.equal(r.armed, false);
    assert.match(r.reason, /valid Stellar secret seed/);
    assert.ok(!r.reason.includes("SNOTAREALSECRET"), "must not echo the secret");
  }),
);

check("missing spend cap refuses (cap is mandatory)", () =>
  withEnv({ ...ARMED, PION_MAX_PAYMENT_PI: undefined }, TESTNET, (r) => {
    assert.equal(r.armed, false);
    assert.match(r.reason, /PION_MAX_PAYMENT_PI/);
  }),
);

for (const bad of ["0", "-5", "abc", ""]) {
  check(`rejects nonsense cap ${JSON.stringify(bad)}`, () =>
    withEnv({ ...ARMED, PION_MAX_PAYMENT_PI: bad }, TESTNET, (r) => {
      assert.equal(r.armed, false);
    }),
  );
}

check("arms only when all four conditions hold", () =>
  withEnv(ARMED, TESTNET, (r) => {
    assert.equal(r.armed, true);
    assert.equal(r.config.maxAmountStroops, 100_000_000n);
  }),
);

console.log("\nAmount conversion — exact integer stroops, no float drift:");
check("0.1 + 0.2 sums exactly to 0.3 in stroops", () =>
  assert.equal(toStroops("0.1") + toStroops("0.2"), toStroops("0.3")),
);
check("7 decimal places accepted", () => assert.equal(toStroops("1.0000001"), 10_000_001n));
check("8 decimal places rejected", () => assert.equal(toStroops("1.00000001"), null));
check("negative rejected", () => assert.equal(toStroops("-1"), null));
check("non-numeric rejected", () => assert.equal(toStroops("1e5"), null));

console.log("\nTool exposure:");

async function toolsWith(env) {
  const client = new Client({ name: "arming-test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { ...process.env, ...env },
    }),
  );
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  await client.close();
  return names;
}

const disarmedTools = await toolsWith({ PION_ENABLE_PAYMENTS: "" });
check("disarmed server does not advertise send_payment", () =>
  assert.ok(!disarmedTools.includes("send_payment"), `saw: ${disarmedTools.join(", ")}`),
);

const armedTools = await toolsWith(ARMED);
check("armed server does advertise send_payment", () =>
  assert.ok(armedTools.includes("send_payment"), `saw: ${armedTools.join(", ")}`),
);

console.log("\nSpend cap enforcement (armed, cap = 10 Pi):");

const client = new Client({ name: "arming-test", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, ...ARMED },
  }),
);

// Over the cap: must be refused locally, before any network call or signing.
const overCap = await client.callTool({
  name: "send_payment",
  arguments: { uid: "test-uid", amount: "10.0000001", memo: "cap test" },
});
check("payment 0.0000001 Pi over the cap is refused", () => {
  assert.equal(overCap.isError, true);
  assert.match(overCap.content[0].text, /exceeds the configured per-payment cap/);
});
check("refusal states nothing was created and no funds moved", () =>
  assert.match(overCap.content[0].text, /Nothing was created and no funds moved/),
);
check("cap cannot be overridden from the tool call", () =>
  assert.match(overCap.content[0].text, /cannot be overridden from here/),
);

const negative = await client.callTool({
  name: "send_payment",
  arguments: { uid: "test-uid", amount: "0", memo: "zero test" },
});
check("zero-amount payment refused", () => assert.equal(negative.isError, true));

// Under-cap payment with a bogus server API key. This does hit the real Pi
// Platform API, which rejects it with a 401 — so the create step fails and
// nothing is ever signed or submitted. It is the one failure stage that can be
// exercised for real without credentials.
console.log("\nCreate-step failure against the live Pi Platform API (bogus key):");
const rejected = await client.callTool({
  name: "send_payment",
  arguments: { uid: "test-uid", amount: "1", memo: "auth failure path" },
});
check("bad server API key fails at the create step", () => {
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /FAILED at the "create" step/);
});
check("reports that no funds moved and it is safe to retry", () =>
  assert.match(rejected.content[0].text, /No payment was created and no funds moved/),
);
check("never echoes the server API key", () =>
  assert.ok(!JSON.stringify(rejected).includes(ARMED.PI_SERVER_API_KEY)),
);
check("never echoes the wallet secret", () =>
  assert.ok(!JSON.stringify(rejected).includes(THROWAWAY_SECRET)),
);

await client.close();

console.log(
  failures === 0
    ? "\nAll arming checks passed.\n"
    : `\n${failures} arming check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);

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

import {
  NetworkConfigError,
  PI_MAINNET,
  PI_TESTNET,
  resolveNetwork,
} from "../dist/networks.js";
import {
  checkPaymentsArming,
  parseCreatedPayment,
  paymentMetadata,
  recordedAmountToStroops,
  toStroops,
} from "../dist/payments.js";

// Generated fresh, never funded, never used. Valid shape, worthless.
const THROWAWAY_SECRET = Keypair.random().secret();

const ARMED = {
  PION_ENABLE_PAYMENTS: "1",
  PI_SERVER_API_KEY: "fake-key-for-guard-testing",
  PI_WALLET_SECRET: THROWAWAY_SECRET,
  PION_MAX_PAYMENT_PI: "10",
};
const TESTNET = PI_TESTNET;

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
function withEnv(overrides, network, fn) {
  const saved = { ...process.env };
  for (const key of Object.keys(ARMED)) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn(checkPaymentsArming(network));
  } finally {
    process.env = saved;
  }
}

console.log("\nNetwork resolution — one source of truth for which chain we read:");

check("defaults to testnet with no configuration", () => {
  const { network } = resolveNetwork({});
  assert.equal(network.id, "testnet");
  assert.equal(network.horizonUrl, "https://api.testnet.minepi.com");
  assert.equal(network.passphrase, "Pi Testnet");
  assert.equal(network.isTestnet, true);
});

// The value the naming pattern gets wrong. Verified against the live node.
check('mainnet passphrase is "Pi Network", not "Pi Mainnet"', () => {
  const { network } = resolveNetwork({ PION_NETWORK: "mainnet" });
  assert.equal(network.id, "mainnet");
  assert.equal(network.horizonUrl, "https://api.mainnet.minepi.com");
  assert.equal(network.passphrase, "Pi Network");
  assert.equal(network.isTestnet, false);
});

check("mainnet label and passphrase are separate values", () =>
  assert.notEqual(PI_MAINNET.label, PI_MAINNET.passphrase),
);

check("an unknown PION_NETWORK refuses to start rather than defaulting", () =>
  assert.throws(() => resolveNetwork({ PION_NETWORK: "manet" }), NetworkConfigError),
);

check("PION_NETWORK is case- and whitespace-tolerant", () =>
  assert.equal(resolveNetwork({ PION_NETWORK: "  MainNet " }).network.id, "mainnet"),
);

check("an explicit URL matching a known network resolves to it", () =>
  assert.equal(
    resolveNetwork({ PION_HORIZON_URL: "https://api.mainnet.minepi.com/" }).network.id,
    "mainnet",
  ),
);

check("PION_NETWORK and PION_HORIZON_URL naming different chains is fatal", () =>
  assert.throws(
    () =>
      resolveNetwork({
        PION_NETWORK: "mainnet",
        PION_HORIZON_URL: "https://api.testnet.minepi.com",
      }),
    NetworkConfigError,
  ),
);

check("an unrecognised endpoint resolves to custom, never to a Pi network", () => {
  const { network, warning } = resolveNetwork({ PION_HORIZON_URL: "https://example.invalid" });
  assert.equal(network.id, "custom");
  assert.equal(network.isTestnet, false);
  assert.equal(network.passphrase, undefined);
  assert.ok(warning, "a custom endpoint must warn");
});

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

check("refuses mainnet even when fully configured", () =>
  withEnv(ARMED, PI_MAINNET, (r) => {
    assert.equal(r.armed, false);
    assert.match(r.reason, /not Pi Testnet/);
  }),
);

check("refuses mainnet selected the way a user selects it", () =>
  withEnv(ARMED, resolveNetwork({ PION_NETWORK: "mainnet" }).network, (r) => {
    assert.equal(r.armed, false);
    assert.match(r.reason, /PION_NETWORK=mainnet/);
  }),
);

// The hole the v0.4 hardening closes. Arming used to be a substring test for
// "testnet" anywhere in the Horizon URL, which every string below satisfies.
for (const spoof of [
  "https://api.mainnet.minepi.com/#testnet",
  "https://api.mainnet.minepi.com/?net=testnet",
  "https://testnet.example.invalid",
  "https://api.testnet.minepi.com.example.invalid",
]) {
  check(`refuses testnet-lookalike URL ${spoof}`, () =>
    withEnv(ARMED, resolveNetwork({ PION_HORIZON_URL: spoof }).network, (r) => {
      assert.equal(r.armed, false, "a URL containing 'testnet' must not be enough to arm");
      assert.match(r.reason, /not Pi Testnet/);
    }),
  );
}

check("refuses a custom endpoint even when it is genuinely reachable", () =>
  withEnv(ARMED, resolveNetwork({ PION_HORIZON_URL: "http://127.0.0.1:8000" }).network, (r) =>
    assert.equal(r.armed, false),
  ),
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

console.log("\nCreate-request metadata — Pi rejects an empty object:");

check("supplies a default when metadata is omitted", () =>
  assert.ok(Object.keys(paymentMetadata(undefined)).length > 0),
);
check("supplies a default when metadata is an empty object", () =>
  assert.ok(Object.keys(paymentMetadata({})).length > 0),
);
check("passes caller metadata through untouched", () =>
  assert.deepEqual(paymentMetadata({ order: "abc", n: 1 }), { order: "abc", n: 1 }),
);
check("the default carries provenance and nothing about the user", () =>
  assert.deepEqual(paymentMetadata(), { source: "pion-mcp" }),
);

console.log("\nCreate-response parsing — the fields send_payment depends on:");

/**
 * A real create response, trimmed to the fields we read (probe, 2026-07-31).
 *
 * The identifier is the genuine one — its 28-byte length is the point of the
 * memo tests. The address is a freshly generated throwaway: the shape is what
 * matters here, and this repo is public, so a real person's wallet does not
 * belong in a fixture (same reasoning that keeps uids out — see tool-mapping).
 */
const LIVE_CREATE = {
  identifier: "tG76m134ce43WkPasVL8nCWLUomS",
  to_address: "GA2LCCTQOYPQEK4NTKJMF7KG6PDPPTVGCM5IUFU7VMMK2RG445WJK5GE",
  from_address: "GBRXHUGQMPCPDZY7YQSHXWMHK6QIBTUKPMNKPSAF7HB4VYPHU7Z5VJVJ",
  amount: 1e-7,
  status: { developer_approved: true, cancelled: false },
};

check("accepts a real create response", () => {
  const r = parseCreatedPayment(LIVE_CREATE);
  assert.equal(r.ok, true);
  assert.equal(r.payment.to_address, LIVE_CREATE.to_address);
});

check("tolerates unknown fields Pi may add", () =>
  assert.equal(parseCreatedPayment({ ...LIVE_CREATE, some_new_field: 1 }).ok, true),
);

// The regression that motivated all of this: the recipient wallet under the
// name an earlier version of the code guessed. A cast accepted it silently.
check("rejects the old `recipient` field name", () => {
  const { to_address, ...rest } = LIVE_CREATE;
  const r = parseCreatedPayment({ ...rest, recipient: to_address });
  assert.equal(r.ok, false);
  assert.match(r.issues, /to_address/);
});

check("rejects a malformed wallet address", () =>
  assert.equal(parseCreatedPayment({ ...LIVE_CREATE, to_address: "not-a-key" }).ok, false),
);

// from_address is the wallet Pi SELECTED, which need not be the one our secret
// unlocks. send_payment compares the two before signing; the parse has to
// surface the field for that comparison to be possible at all.
check("requires from_address — the sender Pi expects", () => {
  const { from_address, ...rest } = LIVE_CREATE;
  const r = parseCreatedPayment(rest);
  assert.equal(r.ok, false);
  assert.match(r.issues, /from_address/);
});

check("recovers the payment id even when the shape is wrong", () => {
  const r = parseCreatedPayment({ identifier: "abc123", garbage: true });
  assert.equal(r.ok, false);
  assert.equal(r.identifier, "abc123");
});

check("reports no id when the body carries none", () =>
  assert.equal(parseCreatedPayment({ garbage: true }).identifier, undefined),
);

check("survives a null or non-object body", () => {
  assert.equal(parseCreatedPayment(null).ok, false);
  assert.equal(parseCreatedPayment("nope").ok, false);
});

// Pi returns amounts as JSON numbers, and small ones in exponential notation.
check("exponential amounts convert to exact stroops", () => {
  assert.equal(recordedAmountToStroops(1e-7), 1n);
  assert.equal(recordedAmountToStroops(0.314), 3_140_000n);
  assert.equal(recordedAmountToStroops(0.1) + recordedAmountToStroops(0.2), toStroops("0.3"));
});

check("a recorded amount that disagrees with the request is detectable", () =>
  assert.notEqual(recordedAmountToStroops(1.0), toStroops("0.001")),
);

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

// The v0.4 claim, end to end: every payment credential present and correct,
// mainnet selected, and the agent still cannot see a spending tool.
const mainnetTools = await toolsWith({ ...ARMED, PION_NETWORK: "mainnet" });
check("mainnet server does not advertise send_payment despite full credentials", () =>
  assert.ok(!mainnetTools.includes("send_payment"), `saw: ${mainnetTools.join(", ")}`),
);
check("mainnet server still advertises the read tools", () =>
  assert.ok(
    ["get_wallet_balance", "get_account_payments", "query_transaction"].every((t) =>
      mainnetTools.includes(t),
    ),
    `saw: ${mainnetTools.join(", ")}`,
  ),
);

const badNetwork = await new Promise((resolve) => {
  const child = spawn(process.execPath, ["dist/index.js"], {
    env: { ...process.env, PION_NETWORK: "manet" },
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.on("exit", (code) => resolve({ code, stderr }));
});
check("server exits non-zero on an unknown PION_NETWORK", () =>
  assert.notEqual(badNetwork.code, 0),
);
check("and names the variable in the failure", () =>
  assert.match(badNetwork.stderr, /PION_NETWORK/),
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

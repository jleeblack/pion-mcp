#!/usr/bin/env node
/**
 * Proves that network selection actually selects a network.
 *
 * The failure this exists to catch is silent and plausible: `PION_NETWORK` is
 * read somewhere it does not reach the Horizon client, every "mainnet" read
 * quietly returns testnet data, and each result is well-formed and labelled
 * "Pi Mainnet". Nothing errors. A smoke test that only checks "the read
 * succeeded" passes.
 *
 * A first version of this test asserted that an account funded on one chain is
 * absent from the other. That is false, and finding out why is the reason this
 * file is worth reading. Measured 2026-08-14: some Pi addresses carry a balance
 * on *both* chains, with different amounts and sequence numbers. Presence is
 * therefore not a network discriminator, and — the part that matters — a read
 * against the wrong chain does not reliably fail. It can return a plausible
 * number. See docs/FINDINGS.md, finding 5.
 *
 * So the checks below use two things that do hold:
 *
 *   1. A wallet we control, funded on testnet only, must be absent from
 *      mainnet. Nobody else can change that.
 *   2. An address present on both chains must return *different* ledger data
 *      from each. Same address, two answers — that is a positive proof the two
 *      chains are being distinguished, and it does not depend on absence.
 *
 * Both fixtures are real and public. Run with `npm run crossnet`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Pion's own app wallet. Funded on testnet, never on mainnet. */
const TESTNET_ONLY = "GATQBZLIAUVMND2OCPOKWGPUCNXIGKMNUU7E67YQI2MODSMCMLXBAIJA";

/**
 * An address holding a balance on both chains — 2.0600000 Pi on mainnet,
 * 32.2993800 Pi on testnet when this was written. The amounts drift; that they
 * differ is the assertion, not what they are.
 */
const BOTH_CHAINS = "GCZYTVXS2K7DY3LJ6F3P5CVH3OU4ZGUKAXAUTE3K7NZGNH55ONISQCMB";

const EXPECTED_LABEL = { mainnet: "Pi Mainnet", testnet: "Pi Testnet" };

async function read(network, address) {
  const client = new Client({ name: "pion-crossnet", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      // The SDK's default stdio env is a filtered allow-list; PION_NETWORK has
      // to be passed through or every child would quietly read testnet.
      env: { ...process.env, PION_NETWORK: network },
    }),
  );
  const result = await client.callTool({ name: "get_wallet_balance", arguments: { address } });
  await client.close();

  if (result.isError) return { found: false, text: result.content[0].text };
  return { found: true, account: JSON.parse(result.content[0].text) };
}

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

console.log("\nCross-network selection — the two chains must give different answers:");

const onTestnet = await read("testnet", TESTNET_ONLY);
const onMainnet = await read("mainnet", TESTNET_ONLY);

check("the app wallet is found on testnet", () => {
  if (!onTestnet.found) throw new Error(onTestnet.text);
});
check("the app wallet is absent from mainnet", () => {
  if (onMainnet.found) {
    throw new Error(
      `a testnet-only wallet returned a mainnet balance of ${onMainnet.account.balances[0]?.balance} — ` +
        "either the chains are not being distinguished, or this wallet has been funded on mainnet",
    );
  }
});
check("the mainnet refusal names the chain it searched", () => {
  if (!onMainnet.text.includes("Pi Mainnet")) throw new Error(onMainnet.text.slice(0, 160));
});

const bothMain = await read("mainnet", BOTH_CHAINS);
const bothTest = await read("testnet", BOTH_CHAINS);

check("the shared address resolves on both chains", () => {
  if (!bothMain.found) throw new Error(`mainnet: ${bothMain.text}`);
  if (!bothTest.found) throw new Error(`testnet: ${bothTest.text}`);
});

// The core assertion. One address, two chains, two different ledger states.
// If selection were a no-op these would be byte-identical.
check("the two chains return different ledger state for it", () => {
  const m = bothMain.account;
  const t = bothTest.account;
  if (m.sequence === t.sequence && m.last_modified_ledger === t.last_modified_ledger) {
    throw new Error(
      `both networks returned sequence=${m.sequence} ledger=${m.last_modified_ledger} — ` +
        "network selection is not reaching Horizon",
    );
  }
  console.log(
    `      mainnet: ${m.balances[0]?.balance} Pi @ ledger ${m.last_modified_ledger}\n` +
      `      testnet: ${t.balances[0]?.balance} Pi @ ledger ${t.last_modified_ledger}`,
  );
});

check("each result is labelled with the chain that was asked for", () => {
  if (bothMain.account.network !== EXPECTED_LABEL.mainnet) {
    throw new Error(`mainnet read labelled "${bothMain.account.network}"`);
  }
  if (bothTest.account.network !== EXPECTED_LABEL.testnet) {
    throw new Error(`testnet read labelled "${bothTest.account.network}"`);
  }
});

console.log(
  failures === 0
    ? "\nBoth chains distinguished. Network selection is real.\n"
    : `\n${failures} cross-network check(s) FAILED — the chains may not be distinguished.\n`,
);
process.exit(failures === 0 ? 0 : 1);

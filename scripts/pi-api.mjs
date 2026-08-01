/**
 * Shared Platform API plumbing for the payment recovery scripts.
 *
 * These are the tools you reach for when a payment is stranded, so they favour
 * saying exactly what Pi said over interpreting it. Every one of them prints
 * the raw response.
 *
 * The server API key comes from the environment only — never an argument. See
 * `guard-argv.mjs` for why that is enforced rather than merely documented.
 */

export const PLATFORM_URL = (process.env.PION_PLATFORM_URL ?? "https://api.minepi.com").replace(
  /\/+$/,
  "",
);

/** Interpolated into a request path, so matched against a fixed charset. */
export const isPaymentId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/**
 * A Stellar transaction hash: exactly 64 hex characters.
 *
 * Deliberately stricter than "some alphanumeric string". These scripts are run
 * during an incident, from a hash copied out of a failure report, and a typo
 * that still parses is worse here than anywhere else.
 */
export const isTxid = (v) => typeof v === "string" && /^[0-9a-fA-F]{64}$/.test(v);

export function requireApiKey() {
  const key = process.env.PI_SERVER_API_KEY;
  if (!key) {
    console.error("PI_SERVER_API_KEY is not set in this shell.\n");
    console.error("Set it without leaving the value on screen or in history:");
    console.error('  $s = Read-Host "Server API key" -AsSecureString');
    console.error("  $env:PI_SERVER_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto(");
    console.error("    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))");
    process.exit(1);
  }
  return key;
}

export async function call(method, path, key, body) {
  const res = await fetch(`${PLATFORM_URL}${path}`, {
    method,
    headers: {
      authorization: `Key ${key}`,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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

const HORIZON_URL = (process.env.PION_HORIZON_URL ?? "https://api.testnet.minepi.com").replace(
  /\/+$/,
  "",
);

/**
 * Searches the chain for the transaction belonging to a payment.
 *
 * Necessary because Pi's record cannot answer the question. Pi learns a txid
 * only when `/complete` succeeds, so a payment whose transaction landed but was
 * never reported looks *identical* to one that was never submitted: both show
 * `transaction: null` (drill B, 2026-08-01). Cancelling the first loses funds
 * the recipient has already received.
 *
 * The chain can answer it because the payment identifier rides on-chain as the
 * Stellar text memo — the same 28-byte design that makes A2U work at all.
 *
 * Walks newest-first only as far back as the payment's own creation time.
 * Stops on an empty page rather than on a missing cursor: Horizon emits a
 * `next` link even past the end of a result set.
 *
 * Returns `{ found }` with a transaction or null, or `{ inconclusive, reason }`
 * — never a bare "no" it cannot stand behind.
 */
export async function findChainTransaction(fromAddress, identifier, createdAt) {
  const floor = new Date(createdAt).getTime() - 60_000; // a minute of slack
  let url = `${HORIZON_URL}/accounts/${fromAddress}/transactions?order=desc&limit=200`;

  for (let page = 0; page < 5; page++) {
    let res;
    try {
      res = await fetch(url, { headers: { accept: "application/json" } });
    } catch (err) {
      return { inconclusive: true, reason: `Horizon unreachable: ${err.message}` };
    }
    if (res.status === 404) {
      return { found: null, note: "the sending account does not exist on-chain" };
    }
    if (!res.ok) {
      return { inconclusive: true, reason: `Horizon returned ${res.status}` };
    }

    const body = await res.json();
    const records = body._embedded?.records ?? [];
    if (records.length === 0) return { found: null };

    for (const tx of records) {
      if (tx.memo === identifier && tx.successful) return { found: tx };
    }

    const oldest = records[records.length - 1];
    if (new Date(oldest.created_at).getTime() < floor) return { found: null };

    url = body._links?.next?.href;
    if (!url) return { found: null };
  }

  // Ran out of pages before reaching the payment's own age. Saying "not found"
  // here would be a guess, and the guess that loses money.
  return { inconclusive: true, reason: "searched 5 pages without reaching the payment's age" };
}

/**
 * One line naming the terminal state, so "did the recovery work?" is
 * answerable at a glance rather than by reading five booleans.
 */
export function stateLine(payment) {
  const s = payment?.status ?? {};
  const verdict = s.cancelled
    ? "CANCELLED"
    : s.developer_completed
      ? "COMPLETED"
      : s.transaction_verified
        ? "SUBMITTED, NOT COMPLETED"
        : "PENDING — no transaction recorded";

  return (
    `State: ${verdict}\n` +
    `  developer_approved   ${s.developer_approved}\n` +
    `  transaction_verified ${s.transaction_verified}\n` +
    `  developer_completed  ${s.developer_completed}\n` +
    `  cancelled            ${s.cancelled}\n` +
    `  txid                 ${payment?.transaction?.txid ?? "(none)"}`
  );
}

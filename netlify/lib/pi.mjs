/**
 * Server-side helpers for the U2A payment functions.
 *
 * These run on Netlify, not in the browser, and they are the only place the
 * server API key is read. Layer 2 in docs/pi-sdk-notes.md: `Authorization: Key
 * <key>` unlocks the payment endpoints and must never reach a client.
 *
 * Everything here follows the hostile-client rule from those notes: a request
 * arriving from the page is a *claim*, not evidence. The only facts we act on
 * are the ones the Pi Platform API tells us directly.
 */

const PLATFORM_URL = (process.env.PION_PLATFORM_URL ?? "https://api.minepi.com").replace(
  /\/+$/,
  "",
);
const REQUEST_TIMEOUT_MS = 15_000;

/** What this test page is allowed to move. A payment that differs is refused. */
export const EXPECTED_AMOUNT = 0.314;
export const EXPECTED_MEMO = "Pion setup test";

// Both identifiers are interpolated into a request path, so they are matched
// against a fixed charset rather than merely checked for being strings.
const PAYMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TXID_RE = /^[A-Za-z0-9]{1,128}$/;

export const isPaymentId = (v) => typeof v === "string" && PAYMENT_ID_RE.test(v);
export const isTxid = (v) => typeof v === "string" && TXID_RE.test(v);

/** JSON response with caching disabled — payment state is never cacheable. */
export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Guard shared by both functions: POST only, JSON body, key configured.
 * Returns either `{ response }` to send back immediately, or `{ key, body }`.
 */
export async function precheck(req) {
  if (req.method !== "POST") {
    return { response: json(405, { error: "method_not_allowed", message: "Use POST." }) };
  }

  const key = process.env.PI_SERVER_API_KEY;
  if (!key) {
    // A configuration fault, not a client fault — and the message says what is
    // missing without hinting at any value.
    return {
      response: json(503, {
        error: "not_configured",
        message: "PI_SERVER_API_KEY is not set on this deploy. Add it in Netlify env settings.",
      }),
    };
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return { response: json(400, { error: "bad_json", message: "Body must be JSON." }) };
  }
  if (body === null || typeof body !== "object") {
    return { response: json(400, { error: "bad_json", message: "Body must be a JSON object." }) };
  }

  return { key, body };
}

/**
 * One Platform API call. Never throws on a non-2xx — the status is data the
 * callers need to reason about — and never returns the raw error object,
 * which can echo the request headers and with them the API key.
 */
export async function piFetch(method, path, key, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${PLATFORM_URL}${path}`, {
      method,
      headers: {
        authorization: `Key ${key}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    return {
      ok: false,
      network: true,
      status: 0,
      detail: controller.signal.aborted
        ? `Pi Platform API did not respond within ${REQUEST_TIMEOUT_MS}ms`
        : `Could not reach the Pi Platform API: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text().catch(() => "");
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = undefined;
  }

  return {
    ok: res.ok,
    network: false,
    status: res.status,
    data,
    detail: data?.error_message ?? data?.error ?? raw.trim().slice(0, 300),
  };
}

/**
 * Turn a failed Platform call into a response for the browser.
 *
 * 401/403 means *our* key was rejected, and 5xx means Pi is unwell; neither is
 * something the caller did, so both surface as 502 rather than being blamed on
 * the request. Everything else (404 unknown payment, 400 bad state) is about
 * the payment itself and passes through unchanged.
 */
export function upstreamFailure(stage, result) {
  const ours = result.network || result.status >= 500 || result.status === 401 || result.status === 403;
  return json(ours ? 502 : result.status, {
    error: "platform_error",
    stage,
    upstreamStatus: result.status || null,
    message: result.detail || `Pi returned ${result.status} at ${stage}.`,
  });
}

/**
 * Does this payment match the one this page is allowed to handle?
 *
 * The browser sends only an id. Without this check a hostile client could hand
 * us the id of some *other* payment of this app and have the server approve it
 * — the id being real is not the same as the payment being the one we offered.
 */
export function expectationProblems(payment) {
  const problems = [];
  const amount = Number(payment?.amount);

  if (!Number.isFinite(amount) || Math.abs(amount - EXPECTED_AMOUNT) > 1e-9) {
    problems.push(`amount is ${payment?.amount}, expected ${EXPECTED_AMOUNT}`);
  }
  if (payment?.memo !== EXPECTED_MEMO) {
    problems.push(`memo is ${JSON.stringify(payment?.memo)}, expected ${JSON.stringify(EXPECTED_MEMO)}`);
  }
  if (payment?.status?.cancelled) {
    problems.push("payment is already cancelled");
  }
  if (payment?.status?.developer_completed) {
    problems.push("payment is already completed");
  }
  return problems;
}

/**
 * Minimal read-only client for Pi's Horizon (Stellar) API.
 *
 * Every endpoint used here is public and unauthenticated — no API key, no
 * bearer token, no wallet secret. See docs/pi-sdk-notes.md, "Layer 3".
 */

import { NETWORK } from "./networks.js";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Horizon base URL for the selected network.
 *
 * Derived from the resolved network rather than read from the environment
 * directly, so there is exactly one place that decides which chain we are on.
 * `PION_NETWORK` and `PION_HORIZON_URL` are both handled in networks.ts.
 */
export const HORIZON_URL = NETWORK.horizonUrl;

/** A Horizon request that failed — network, timeout, or non-2xx response. */
export class HorizonError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HorizonError";
  }
}

/** Horizon's RFC 7807 problem document. */
interface HorizonProblem {
  title?: string;
  detail?: string;
  extras?: { reason?: string; result_codes?: unknown };
}

type QueryParams = Record<string, string | number | undefined>;

export async function horizonGet<T>(path: string, params?: QueryParams): Promise<T> {
  const url = new URL(HORIZON_URL + path);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new HorizonError(`Horizon request timed out after ${REQUEST_TIMEOUT_MS}ms: ${path}`);
    }
    throw new HorizonError(`Could not reach Horizon at ${HORIZON_URL}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new HorizonError(await describeFailure(response, path), response.status);
  }

  return (await response.json()) as T;
}

async function describeFailure(response: Response, path: string): Promise<string> {
  let problem: HorizonProblem = {};
  try {
    problem = (await response.json()) as HorizonProblem;
  } catch {
    // Non-JSON error body — fall through to the generic message.
  }

  if (response.status === 404) {
    // Name the network. A common cause of a surprising 404 is looking for an
    // account on the chain it does not live on, and that is invisible unless
    // said. Note the asymmetry: a 404 is evidence the address is absent *here*,
    // but a success is not evidence you asked the right chain — some addresses
    // exist on both with different balances (docs/pi-sdk-notes.md, Layer 3).
    return (
      `Not found on ${NETWORK.label} Horizon (${HORIZON_URL}${path}). The account or ` +
      `transaction does not exist on ${NETWORK.label}, or has never been funded. ` +
      "Pi Mainnet and Pi Testnet are separate ledgers sharing one address format, so " +
      "this address may still be real on the other chain."
    );
  }

  const parts = [problem.title, problem.detail, problem.extras?.reason].filter(Boolean);
  return parts.length > 0
    ? `Horizon returned ${response.status}: ${parts.join(" — ")}`
    : `Horizon returned ${response.status} ${response.statusText} for ${path}`;
}

/** Renders a Horizon asset triplet as "PI" or "CODE:ISSUER". */
export function formatAsset(
  assetType: string | undefined,
  code: string | undefined,
  issuer: string | undefined,
): string {
  if (!assetType || assetType === "native") return "PI";
  return issuer ? `${code}:${issuer}` : (code ?? assetType);
}

/** Extracts Horizon's paging cursor from a `_links.next.href` value. */
export function cursorFromLink(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, HORIZON_URL).searchParams.get("cursor") ?? undefined;
  } catch {
    return undefined;
  }
}

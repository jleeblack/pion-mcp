/**
 * Minimal read-only client for Pi's Horizon (Stellar) API.
 *
 * Every endpoint used here is public and unauthenticated — no API key, no
 * bearer token, no wallet secret. See docs/pi-sdk-notes.md, "Layer 3".
 */

const DEFAULT_HORIZON_URL = "https://api.testnet.minepi.com";
const REQUEST_TIMEOUT_MS = 15_000;

/** Horizon base URL. Defaults to Pi testnet; override with PION_HORIZON_URL. */
export const HORIZON_URL = (process.env.PION_HORIZON_URL ?? DEFAULT_HORIZON_URL).replace(/\/+$/, "");

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
    return `Not found on Horizon (${HORIZON_URL}${path}). The account or transaction does not exist on this network, or has never been funded.`;
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

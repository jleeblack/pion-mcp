/**
 * Minimal client for the Pi Platform API (Layer 2 in docs/pi-sdk-notes.md).
 *
 * Unlike Horizon, these endpoints are authenticated. This module only ever
 * handles a *user* access token, which the caller supplies per request — it
 * never reads a server API key or wallet secret, and it never persists,
 * logs, or echoes back a token.
 */

const DEFAULT_PLATFORM_URL = "https://api.minepi.com";
const REQUEST_TIMEOUT_MS = 15_000;

/** Platform API base URL. Override with PION_PLATFORM_URL. */
export const PLATFORM_URL = (process.env.PION_PLATFORM_URL ?? DEFAULT_PLATFORM_URL).replace(
  /\/+$/,
  "",
);

/** A Platform API request that failed for reasons other than a bad token. */
export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

/**
 * The token was rejected (401/403). This is a normal, expected answer to
 * "is this token valid?" — not a malfunction — so callers report it as a
 * result rather than an error.
 */
export class PlatformAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PlatformAuthError";
  }
}

export async function platformGet<T>(path: string, accessToken: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${PLATFORM_URL}${path}`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new PlatformError(`Platform API request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    // `err` can echo the request; report only its message, never the headers.
    throw new PlatformError(
      `Could not reach the Pi Platform API at ${PLATFORM_URL}: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new PlatformAuthError(
      response.status === 401
        ? "The Pi Platform API rejected this access token. It is invalid, expired, or was issued for a different app."
        : "This access token is valid but lacks the scope required for this call.",
      response.status,
    );
  }

  if (!response.ok) {
    // 401 responses come back with an empty body, so never assume JSON here.
    const body = await response.text().catch(() => "");
    const detail = body.trim().slice(0, 300);
    throw new PlatformError(
      detail.length > 0
        ? `Pi Platform API returned ${response.status}: ${detail}`
        : `Pi Platform API returned ${response.status} ${response.statusText} for ${path}`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

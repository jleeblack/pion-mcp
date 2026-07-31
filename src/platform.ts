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

/**
 * `Bearer` carries a user access token; `Key` carries the server API key.
 * The credential is only ever used to build the Authorization header.
 */
interface Auth {
  scheme: "Bearer" | "Key";
  credential: string;
}

async function platformRequest<T>(
  method: "GET" | "POST",
  path: string,
  auth: Auth,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${PLATFORM_URL}${path}`, {
      method,
      headers: {
        authorization: `${auth.scheme} ${auth.credential}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
    // Do NOT assume a 401 means bad credentials. /v2/payments returns 401 with
    // {"error":"missing_scope"} when the *recipient* has not granted
    // wallet_address — nothing to do with the caller's key. The body carries
    // the real reason, so read it before blaming the credential.
    const raw = (await response.text().catch(() => "")).trim();
    let apiError: string | undefined;
    let apiMessage: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { error?: string; error_message?: string };
      apiError = parsed.error;
      apiMessage = parsed.error_message;
    } catch {
      // Empty or non-JSON body — fall back to the generic wording below.
    }

    if (apiError !== undefined) {
      throw new PlatformAuthError(
        `Pi rejected the request (${response.status} ${apiError})` +
          (apiMessage ? `: ${apiMessage}` : "") +
          (apiError === "missing_scope"
            ? "\n\nThis is a consent problem, not a credential problem. Your credentials are " +
              "fine: the recipient has not authorized the required scope for your app. For " +
              "A2U that is wallet_address, which lets Pi resolve their wallet.\n\n" +
              "The verified way to obtain it is a Pi Browser SDK grant — the recipient runs " +
              "Pi.authenticate for your app including wallet_address, inside the Pi Browser. " +
              "Whether a Pi Sign-in grant also satisfies this is untested."
            : ""),
        response.status,
      );
    }

    const subject = auth.scheme === "Bearer" ? "access token" : "server API key";
    throw new PlatformAuthError(
      response.status === 401
        ? `The Pi Platform API rejected this ${subject}. It is invalid, expired, or was issued for a different app.`
        : `This ${subject} is valid but lacks the permission required for this call.`,
      response.status,
    );
  }

  if (!response.ok) {
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

/** Authenticated as a user, via their access token. */
export function platformGet<T>(path: string, accessToken: string): Promise<T> {
  return platformRequest<T>("GET", path, { scheme: "Bearer", credential: accessToken });
}

/** Authenticated as the app, via the server API key. Server-side only. */
export function platformPostAsApp<T>(
  path: string,
  serverApiKey: string,
  body?: unknown,
): Promise<T> {
  return platformRequest<T>("POST", path, { scheme: "Key", credential: serverApiKey }, body);
}

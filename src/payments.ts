/**
 * Arming logic and money-safety helpers for Tier C (A2U payments).
 *
 * This is the only part of Pion that can move value, so it is disabled unless
 * every guard below passes. Possessing credentials is deliberately NOT enough
 * to arm it: PION_ENABLE_PAYMENTS is a separate, explicit switch, and
 * PION_MAX_PAYMENT_PI is a required ceiling that bounds worst-case loss no
 * matter how the agent is steered.
 *
 * Neither the server API key nor the wallet secret is ever accepted as a tool
 * argument, returned in a result, or logged.
 */

import { z } from "zod";

/** Stellar amounts carry 7 decimal places; 1 Pi = 10^7 stroops. */
const STROOPS_PER_PI = 10_000_000n;
const AMOUNT_PATTERN = /^\d+(\.\d{1,7})?$/;

/** Stellar public key: 56 base32 characters beginning with G. */
const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

/** Stellar secret seed: 56 base32 characters beginning with S. */
const SECRET_PATTERN = /^S[A-Z2-7]{55}$/;

export interface PaymentsConfig {
  serverApiKey: string;
  walletSecret: string;
  maxAmountStroops: bigint;
  maxAmountPi: string;
}

export type PaymentsArming =
  | { armed: true; config: PaymentsConfig }
  | { armed: false; reason: string };

/**
 * Converts a decimal Pi amount to stroops exactly. Comparisons against the
 * spend cap are done in integer stroops rather than floats — this is money,
 * and 0.1 + 0.2 problems are not acceptable in a ceiling check.
 */
export function toStroops(amount: string): bigint | null {
  if (!AMOUNT_PATTERN.test(amount)) return null;
  const dot = amount.indexOf(".");
  const whole = dot === -1 ? amount : amount.slice(0, dot);
  const fraction = dot === -1 ? "" : amount.slice(dot + 1);
  return BigInt(whole) * STROOPS_PER_PI + BigInt(fraction.padEnd(7, "0"));
}

/**
 * Metadata for a create-payment call, guaranteed non-empty.
 *
 * Pi rejects `POST /v2/payments` with `400 invalid_metadata` — "Metadata can't
 * be empty" — when the field is `{}`. This is undocumented, and it is invisible
 * in testing if every probe happens to pass something: ours did, so an omitted
 * metadata argument stayed broken until the first real send (2026-08-01).
 *
 * The default carries provenance and nothing about the user.
 */
export function paymentMetadata(
  supplied?: Record<string, unknown>,
): Record<string, unknown> {
  if (supplied && Object.keys(supplied).length > 0) return supplied;
  return { source: "pion-mcp" };
}

/**
 * Runtime shape check for the create-payment fields `send_payment` depends on.
 *
 * Parsed rather than cast, on purpose. An earlier version of this codebase
 * declared the recipient wallet as `recipient` — a name Pi never returns — and
 * a cast turned that into `undefined` at runtime instead of a type error. Every
 * A2U payment would have failed while building the transaction, stranding a
 * record each time, with nothing in the failure to point at the cause.
 *
 * Deliberately narrow: it covers only the fields actually read, so an unrelated
 * addition to Pi's response never blocks a payment, while a rename of something
 * load-bearing stops it before anything is signed.
 *
 * Field names verified against a live response (`npm run probe:a2u`, 2026-07-31).
 */
export const createdPaymentSchema = z.object({
  identifier: z.string().min(1),
  /** The recipient's wallet. Present on create — no separate lookup needed. */
  to_address: z.string().regex(STELLAR_ADDRESS, "is not a Stellar public key"),
  /**
   * The wallet Pi expects to send from — the app wallet *selected* in the
   * Developer Portal, which is not necessarily the one `PI_WALLET_SECRET`
   * unlocks. Observed 2026-08-01: Pi returns the selected wallet here
   * regardless of what key the app actually holds, so this is the only place
   * the two can be compared before signing.
   */
  from_address: z.string().regex(STELLAR_ADDRESS, "is not a Stellar public key"),
  /** Pi's record of the amount, to be cross-checked against what was asked. */
  amount: z.number().finite(),
  status: z.object({
    developer_approved: z.boolean(),
    cancelled: z.boolean(),
  }),
});

export type CreatedPayment = z.infer<typeof createdPaymentSchema>;

export type ParsedCreate =
  | { ok: true; payment: CreatedPayment }
  | { ok: false; issues: string; identifier: string | undefined };

/**
 * Validates a create-payment response.
 *
 * On failure it still digs the identifier out of the raw body if one is there:
 * a record may exist even when the response cannot be understood, and a
 * stranded payment with no id is far worse than one with an id.
 */
export function parseCreatedPayment(raw: unknown): ParsedCreate {
  const parsed = createdPaymentSchema.safeParse(raw);
  if (parsed.success) return { ok: true, payment: parsed.data };

  const loose = (raw as { identifier?: unknown } | null | undefined)?.identifier;
  return {
    ok: false,
    issues: parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; "),
    identifier: typeof loose === "string" && loose.length > 0 ? loose : undefined,
  };
}

/**
 * Converts Pi's recorded amount to stroops for comparison against the request.
 *
 * Never via `String(amount)`: Pi returns amounts as JSON numbers and small ones
 * arrive in exponential notation — a real `1e-7` was observed — which does not
 * match the decimal pattern `toStroops` expects.
 */
export function recordedAmountToStroops(amount: number): bigint {
  return BigInt(Math.round(amount * Number(STROOPS_PER_PI)));
}

/**
 * Decides whether payments may run at all. Returns a specific reason on
 * refusal so an operator can tell a missing switch from a missing credential.
 */
export function checkPaymentsArming(horizonUrl: string): PaymentsArming {
  const enable = process.env.PION_ENABLE_PAYMENTS;
  if (enable !== "1" && enable?.toLowerCase() !== "true") {
    return {
      armed: false,
      reason: "PION_ENABLE_PAYMENTS is not set to 1 — payments are off by default",
    };
  }

  // A2U is testnet-only per Pi's payments_advanced.md. Refuse anything else
  // rather than discovering the restriction mid-flow with a created payment.
  if (!horizonUrl.includes("testnet")) {
    return {
      armed: false,
      reason:
        `Horizon is set to ${horizonUrl}, which is not testnet. Pi restricts ` +
        "App-to-User payments to testnet, and Pion will not attempt them elsewhere.",
    };
  }

  const serverApiKey = process.env.PI_SERVER_API_KEY;
  if (!serverApiKey) {
    return { armed: false, reason: "PI_SERVER_API_KEY is not set" };
  }

  const walletSecret = process.env.PI_WALLET_SECRET;
  if (!walletSecret) {
    return { armed: false, reason: "PI_WALLET_SECRET is not set" };
  }
  if (!SECRET_PATTERN.test(walletSecret)) {
    // Never echo the value — say only that the shape is wrong.
    return {
      armed: false,
      reason:
        "PI_WALLET_SECRET is not a valid Stellar secret seed (expected 56 characters starting with S)",
    };
  }

  const rawCap = process.env.PION_MAX_PAYMENT_PI;
  if (!rawCap) {
    return {
      armed: false,
      reason:
        "PION_MAX_PAYMENT_PI is not set. A per-payment ceiling is required — " +
        "it is what bounds the damage if the agent is manipulated.",
    };
  }
  const maxAmountStroops = toStroops(rawCap.trim());
  if (maxAmountStroops === null || maxAmountStroops <= 0n) {
    return {
      armed: false,
      reason: `PION_MAX_PAYMENT_PI must be a positive decimal amount of Pi, got "${rawCap}"`,
    };
  }

  return {
    armed: true,
    config: { serverApiKey, walletSecret, maxAmountStroops, maxAmountPi: rawCap.trim() },
  };
}

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

/** Stellar amounts carry 7 decimal places; 1 Pi = 10^7 stroops. */
const STROOPS_PER_PI = 10_000_000n;
const AMOUNT_PATTERN = /^\d+(\.\d{1,7})?$/;

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

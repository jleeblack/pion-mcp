import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { HorizonError } from "../horizon.js";
import type { PiNetwork } from "../networks.js";
import { PlatformError } from "../platform.js";

/**
 * The sentence every Tier A tool description ends with.
 *
 * Named once so all three read tools say the same thing about the same fact.
 * An agent that only ever sees a tool description — never the startup banner —
 * still learns which chain it is reading and why that matters.
 *
 * The wording is deliberate about what a wrong-chain read looks like. Measured
 * 2026-08-14: some Pi addresses hold a balance on *both* chains, with different
 * amounts (docs/FINDINGS.md, finding 5). So querying the wrong network does not
 * reliably produce a not-found error — it can produce a well-formed, plausible,
 * wrong number. That is why the network is stated rather than implied.
 */
export function networkNote(network: PiNetwork): string {
  return (
    `This server reads ${network.label}, and every result repeats that in its ` +
    '"network" field — always report which chain a figure came from. Pi Mainnet ' +
    "and Pi Testnet are separate ledgers sharing one address format, and the same " +
    "address can hold different balances on each, so a result from the wrong chain " +
    "looks entirely normal. Testnet Pi has no monetary value: never present a " +
    "testnet balance as real holdings."
  );
}

/**
 * Stellar/Pi public key: 56 base32 characters beginning with G.
 *
 * The description states the alphabet, not just the length, because base32
 * excludes 0/1/8/9 — the characters a human is most likely to introduce when
 * retyping an address. It also carries an example, and a warning against
 * reusing it: the regex here proves the *shape*, and nothing more. A different
 * well-formed address is not rejected, it is answered, so a copied example
 * returns a real balance belonging to someone else. That is the same silent
 * wrong answer the network stamp exists to prevent (see `networkNote`).
 *
 * Note the checksum is deliberately not verified here. Strkey carries a CRC16
 * that this regex cannot see, so a mistyped-but-well-formed address reaches
 * Horizon and comes back as a 400 rather than a local validation error.
 */
export const walletAddress = z
  .string()
  .regex(
    /^G[A-Z2-7]{55}$/,
    "must be a Pi wallet address: exactly 56 characters, starting with G, the rest " +
      "base32 (A-Z and 2-7 only — never 0, 1, 8 or 9)",
  )
  .describe(
    "Pi wallet address (a Stellar public key): exactly 56 upper-case characters, " +
      "starting with G, the rest base32 — A-Z and 2-7 only, never 0, 1, 8 or 9. " +
      "Example: GATQBZLIAUVMND2OCPOKWGPUCNXIGKMNUU7E67YQI2MODSMCMLXBAIJA — that is a " +
      "format sample, not a default. Pass the address you were actually given: a valid " +
      "address that is not the intended one returns someone else's balance, not an error.",
  );

/**
 * Stellar transaction hash: 64 hex characters.
 *
 * Either case is accepted and `query_transaction` lowercases before the request,
 * so the description says so rather than implying lower-case-only input.
 *
 * The "not a payment id" clause is load-bearing. Pi's A2U flow hands out a
 * payment identifier and a txid that are different things at different layers
 * (docs/runbook.md), and an agent holding one of them has no format cue telling
 * it which endpoint wants which.
 */
export const transactionHash = z
  .string()
  .regex(
    /^[0-9a-fA-F]{64}$/,
    "must be a transaction hash: exactly 64 hexadecimal characters (0-9 and a-f)",
  )
  .describe(
    "On-chain transaction hash: exactly 64 hexadecimal characters (0-9 and a-f). " +
      "Upper case is accepted and normalized to lower case. This is the Stellar " +
      "transaction hash — not a Pi payment id, not a ledger sequence number, not a memo. " +
      "Example: f8b6d6c83dfb32452330b677d901748fb6cece6c36d9b2deff64bead6e1c6925",
  );

export const pagingLimit = z
  .number()
  .int()
  .min(1)
  .max(200)
  .default(10)
  .describe("How many records to return (1-200). Defaults to 10.");

export const pagingCursor = z
  .string()
  .optional()
  .describe("Paging cursor from a previous call's `next_cursor`. Omit for the first page.");

export const pagingOrder = z
  .enum(["asc", "desc"])
  .default("desc")
  .describe("`desc` returns newest records first (the default); `asc` returns oldest first.");

/** A successful tool result: JSON text for humans, structured content for agents. */
export function ok<T extends Record<string, unknown>>(data: T): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/**
 * A failed tool result. `isError` keeps the failure inside the conversation
 * so the agent can react, rather than faulting the transport.
 */
export function fail(error: unknown): CallToolResult {
  const message =
    error instanceof HorizonError || error instanceof PlatformError
      ? error.message
      : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  return { content: [{ type: "text", text: message }], isError: true };
}

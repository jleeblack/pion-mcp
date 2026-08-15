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
 * amounts (see docs/pi-sdk-notes.md, Layer 3). So querying the wrong network does not
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

/** Stellar/Pi public key: 56 base32 characters beginning with G. */
export const walletAddress = z
  .string()
  .regex(
    /^G[A-Z2-7]{55}$/,
    "must be a 56-character Pi wallet address starting with G (e.g. GABC...XYZ)",
  )
  .describe("Pi wallet address (Stellar public key, 56 characters, starts with G)");

/** Stellar transaction hash: 64 hex characters. */
export const transactionHash = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be a 64-character hex transaction hash")
  .describe("Transaction hash (64 hex characters)");

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

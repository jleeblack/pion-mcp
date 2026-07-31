import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { HORIZON_URL, HorizonError } from "../horizon.js";

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

/** A failed tool result. `isError` keeps the failure inside the conversation. */
export function fail(error: unknown): CallToolResult {
  const message =
    error instanceof HorizonError
      ? error.message
      : `Unexpected error querying ${HORIZON_URL}: ${
          error instanceof Error ? error.message : String(error)
        }`;
  return { content: [{ type: "text", text: message }], isError: true };
}

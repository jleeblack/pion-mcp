import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { horizonGet } from "../horizon.js";
import type { PiNetwork } from "../networks.js";
import { fail, networkNote, ok, transactionHash } from "./common.js";

interface HorizonTransaction {
  hash: string;
  ledger: number;
  successful: boolean;
  created_at: string;
  source_account: string;
  source_account_sequence: string;
  fee_account?: string;
  fee_charged: string;
  operation_count: number;
  memo?: string;
  memo_type: string;
  result_code?: string;
}

const outputSchema = {
  network: z.string(),
  hash: z.string(),
  successful: z.boolean(),
  ledger: z.number(),
  created_at: z.string(),
  source_account: z.string(),
  source_account_sequence: z.string(),
  fee_account: z.string().optional(),
  fee_charged: z.string(),
  operation_count: z.number(),
  memo_type: z.string(),
  memo: z.string().optional(),
  result_code: z.string().optional(),
};

export function registerQueryTransaction(server: McpServer, network: PiNetwork): void {
  server.registerTool(
    "query_transaction",
    {
      title: "Look up a Pi transaction",
      description:
        "Look up a single Pi transaction by its hash and report whether it succeeded, " +
        "which ledger it landed in, who submitted it, the fee charged, and its memo. " +
        "Call this to verify that a specific transaction actually went through — a user " +
        "or another service claiming a payment was made is not proof; this is. " +
        "Reads public ledger data only. A hash this chain has no record of returns a " +
        "not-found error, which is not the same answer as `successful: false` — that " +
        "means the transaction did reach a ledger and was rejected there. " +
        networkNote(network),
      inputSchema: { hash: transactionHash },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ hash }) => {
      try {
        const tx = await horizonGet<HorizonTransaction>(`/transactions/${hash.toLowerCase()}`);
        return ok({
          network: network.label,
          hash: tx.hash,
          successful: tx.successful,
          ledger: tx.ledger,
          created_at: tx.created_at,
          source_account: tx.source_account,
          source_account_sequence: tx.source_account_sequence,
          ...(tx.fee_account !== undefined ? { fee_account: tx.fee_account } : {}),
          fee_charged: tx.fee_charged,
          operation_count: tx.operation_count,
          memo_type: tx.memo_type,
          ...(tx.memo !== undefined ? { memo: tx.memo } : {}),
          ...(tx.result_code !== undefined ? { result_code: tx.result_code } : {}),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}

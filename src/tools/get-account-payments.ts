import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { cursorFromLink, formatAsset, horizonGet } from "../horizon.js";
import type { PiNetwork } from "../networks.js";
import {
  fail,
  networkNote,
  ok,
  pagingCursor,
  pagingLimit,
  pagingOrder,
  walletAddress,
} from "./common.js";

/**
 * Horizon's payments endpoint returns several operation types. Fields are
 * declared optional because which ones are present depends on `type`.
 */
interface HorizonPayment {
  id: string;
  type: string;
  created_at: string;
  transaction_hash: string;
  transaction_successful?: boolean;
  // payment / path_payment_*
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  source_amount?: string;
  source_asset_type?: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  // create_account
  funder?: string;
  account?: string;
  starting_balance?: string;
  // account_merge
  into?: string;
}

interface HorizonPaymentsPage {
  _links?: { next?: { href?: string } };
  _embedded: { records: HorizonPayment[] };
}

const paymentShape = z.object({
  id: z.string(),
  type: z.string(),
  created_at: z.string(),
  transaction_hash: z.string(),
  successful: z.boolean().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  amount: z.string().optional(),
  asset: z.string().optional(),
  source_amount: z.string().optional(),
  source_asset: z.string().optional(),
});

const outputSchema = {
  network: z.string(),
  account_id: z.string(),
  count: z.number(),
  next_cursor: z.string().optional(),
  payments: z.array(paymentShape),
};

/** Flattens Horizon's per-type payment records into one consistent shape. */
function normalize(record: HorizonPayment): z.infer<typeof paymentShape> {
  const base = {
    id: record.id,
    type: record.type,
    created_at: record.created_at,
    transaction_hash: record.transaction_hash,
    ...(record.transaction_successful !== undefined
      ? { successful: record.transaction_successful }
      : {}),
  };

  switch (record.type) {
    case "create_account":
      return {
        ...base,
        from: record.funder,
        to: record.account,
        amount: record.starting_balance,
        asset: "PI",
      };
    case "account_merge":
      return { ...base, from: record.account, to: record.into };
    default:
      // Covers payment, path_payment_*, and any other value-moving operation
      // Horizon surfaces here (e.g. invoke_host_function), which may carry no
      // asset fields at all — never assume native.
      return {
        ...base,
        from: record.from,
        to: record.to,
        amount: record.amount,
        ...(record.asset_type !== undefined
          ? { asset: formatAsset(record.asset_type, record.asset_code, record.asset_issuer) }
          : {}),
        ...(record.source_amount !== undefined
          ? {
              source_amount: record.source_amount,
              source_asset: formatAsset(
                record.source_asset_type,
                record.source_asset_code,
                record.source_asset_issuer,
              ),
            }
          : {}),
      };
  }
}

export function registerGetAccountPayments(server: McpServer, network: PiNetwork): void {
  server.registerTool(
    "get_account_payments",
    {
      title: "List Pi wallet payment history",
      description:
        "List payments sent to or from a Pi wallet address, newest first. " +
        "Call this to answer questions about an address's transaction history — whether " +
        "a payment arrived, who funded an account, or what it recently sent. Covers " +
        "payments, account creations, path payments, and account merges. Results are " +
        "paginated: pass the returned `next_cursor` back as `cursor` for the next page. " +
        "Reads public ledger data only. An address never funded on this chain returns a " +
        "not-found error rather than an empty list, so an empty `payments` array means " +
        "you have paged past the end of the history — not that the account is unused. " +
        networkNote(network),
      inputSchema: {
        address: walletAddress,
        limit: pagingLimit,
        cursor: pagingCursor,
        order: pagingOrder,
      },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address, limit, cursor, order }) => {
      try {
        const page = await horizonGet<HorizonPaymentsPage>(`/accounts/${address}/payments`, {
          limit,
          order,
          cursor,
        });
        const payments = page._embedded.records.map(normalize);
        // Horizon always emits a `next` link, even past the end of the result
        // set. Only surface a cursor when the page came back full.
        const nextCursor =
          payments.length === limit ? cursorFromLink(page._links?.next?.href) : undefined;

        return ok({
          network: network.label,
          account_id: address,
          count: payments.length,
          ...(nextCursor !== undefined ? { next_cursor: nextCursor } : {}),
          payments,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}

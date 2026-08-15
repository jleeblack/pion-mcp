import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { formatAsset, horizonGet } from "../horizon.js";
import type { PiNetwork } from "../networks.js";
import { fail, networkNote, ok, walletAddress } from "./common.js";

interface HorizonBalance {
  balance: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  liquidity_pool_id?: string;
  limit?: string;
  is_authorized?: boolean;
}

interface HorizonAccount {
  account_id: string;
  sequence: string;
  subentry_count: number;
  last_modified_ledger: number;
  balances: HorizonBalance[];
}

const outputSchema = {
  network: z.string(),
  account_id: z.string(),
  sequence: z.string(),
  subentry_count: z.number(),
  last_modified_ledger: z.number(),
  balances: z.array(
    z.object({
      asset: z.string(),
      balance: z.string(),
      asset_type: z.string(),
      limit: z.string().optional(),
      is_authorized: z.boolean().optional(),
    }),
  ),
};

export function registerGetWalletBalance(server: McpServer, network: PiNetwork): void {
  server.registerTool(
    "get_wallet_balance",
    {
      title: "Get Pi wallet balance",
      description:
        "Read the current Pi and custom-token balances of a Pi wallet address. " +
        "Call this whenever you need to know how much Pi an address holds, whether it " +
        "holds a particular token, or whether the account exists on-chain at all. " +
        "Reads public ledger data only — it cannot move funds and needs no credentials. " +
        networkNote(network),
      inputSchema: { address: walletAddress },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address }) => {
      try {
        const account = await horizonGet<HorizonAccount>(`/accounts/${address}`);
        return ok({
          network: network.label,
          account_id: account.account_id,
          sequence: account.sequence,
          subentry_count: account.subentry_count,
          last_modified_ledger: account.last_modified_ledger,
          balances: account.balances.map((entry) => ({
            // Liquidity-pool shares carry a pool id instead of a code/issuer.
            asset:
              entry.liquidity_pool_id !== undefined
                ? `pool:${entry.liquidity_pool_id}`
                : formatAsset(entry.asset_type, entry.asset_code, entry.asset_issuer),
            balance: entry.balance,
            asset_type: entry.asset_type,
            ...(entry.limit !== undefined ? { limit: entry.limit } : {}),
            ...(entry.is_authorized !== undefined ? { is_authorized: entry.is_authorized } : {}),
          })),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}

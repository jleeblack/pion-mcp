import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { PlatformAuthError, PLATFORM_URL, platformGet } from "../platform.js";
import { fail, ok } from "./common.js";

/**
 * Shape of `GET /v2/me`, confirmed against a live token:
 *   { app_id, uid, credentials: { scopes[], valid_until: { timestamp, iso8601 } },
 *     receiving_email, username }
 * Everything but `uid` stays optional — the rest depends on granted scopes.
 */
interface PlatformMe {
  uid: string;
  app_id?: string;
  username?: string;
  credentials?: {
    scopes?: string[];
    valid_until?: { timestamp?: number; iso8601?: string };
  };
}

const outputSchema = {
  valid: z.boolean(),
  uid: z.string().optional(),
  username: z.string().optional(),
  app_id: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  valid_until: z.string().optional(),
  reason: z.string().optional(),
};

export function registerVerifyUser(server: McpServer): void {
  server.registerTool(
    "verify_user",
    {
      title: "Verify a Pi user access token",
      description:
        "Check whether a Pi user access token is genuine and, if so, who it belongs to. " +
        "Call this to authenticate someone who claims a Pi identity — never trust a " +
        "client-supplied uid or username on its own; this is the only thing that proves it. " +
        "Returns `valid: false` with a reason for a rejected token rather than failing. " +
        `Sends the token to the Pi Platform API (${PLATFORM_URL}/v2/me) and nothing else; ` +
        "it is not stored or logged. Note the uid is app-specific — the same person has a " +
        "different uid under a different Pi app.",
      inputSchema: {
        access_token: z
          .string()
          .min(1)
          .describe(
            "The user's Pi access token, obtained from Pi Browser authentication or Pi " +
              "Sign-in OAuth. This is a credential — pass the token itself, not a uid.",
          ),
      },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ access_token }) => {
      try {
        const me = await platformGet<PlatformMe>("/v2/me", access_token);
        return ok({
          valid: true,
          uid: me.uid,
          ...(me.username !== undefined ? { username: me.username } : {}),
          // Which app the token was issued for. Worth surfacing: a token from
          // a different app is a valid token that still must not be trusted.
          ...(me.app_id !== undefined ? { app_id: me.app_id } : {}),
          ...(me.credentials?.scopes !== undefined ? { scopes: me.credentials.scopes } : {}),
          ...(me.credentials?.valid_until?.iso8601 !== undefined
            ? { valid_until: me.credentials.valid_until.iso8601 }
            : {}),
        });
      } catch (error) {
        // A rejected token is a real answer to "is this valid?", not a fault.
        if (error instanceof PlatformAuthError) {
          return ok({ valid: false, reason: error.message });
        }
        return fail(error);
      }
    },
  );
}

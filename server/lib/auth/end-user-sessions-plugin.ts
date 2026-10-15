import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index";

export const END_USER_SESSIONS_PATH = "/internal/end-user-sessions";

export const END_SESSIONS_PATH = "/internal/end-sessions";

export const endUserSessionsPlugin = () =>
  ({
    id: "end-user-sessions",
    endpoints: {
      endUserSessions: createAuthEndpoint(
        END_USER_SESSIONS_PATH,
        { method: "POST", body: z.object({ userId: z.string() }), metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          await ctx.context.internalAdapter.deleteUserSessions(ctx.body.userId);

          return ctx.json({ ok: true });
        },
      ),
      endSessions: createAuthEndpoint(
        END_SESSIONS_PATH,
        { method: "POST", body: z.object({ sessionIds: z.array(z.string()) }), metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const rows = ctx.body.sessionIds.length
            ? await db
                .select({ token: schema.session.token })
                .from(schema.session)
                .where(inArray(schema.session.id, ctx.body.sessionIds))
            : [];

          if (rows.length) await ctx.context.internalAdapter.deleteSessions(rows.map((row) => row.token));

          return ctx.json({ ok: true });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;

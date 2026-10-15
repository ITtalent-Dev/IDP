import { and, eq, isNull, ne, or } from "drizzle-orm";
import { db, schema } from "../db/index";

const stillValid = isNull(schema.oauthRefreshToken.revoked);

export async function revokeRefreshTokensForUser(userId: string, opts: { exceptSessionId?: string } = {}) {
  const scope = opts.exceptSessionId
    ? and(
        eq(schema.oauthRefreshToken.userId, userId),
        stillValid,
        or(isNull(schema.oauthRefreshToken.sessionId), ne(schema.oauthRefreshToken.sessionId, opts.exceptSessionId)),
      )
    : and(eq(schema.oauthRefreshToken.userId, userId), stillValid);
  const revoked = await db
    .update(schema.oauthRefreshToken)
    .set({ revoked: new Date() })
    .where(scope)
    .returning({ id: schema.oauthRefreshToken.id });

  return revoked.length;
}

export async function revokeRefreshTokensForSession(sessionId: string) {
  const revoked = await db
    .update(schema.oauthRefreshToken)
    .set({ revoked: new Date() })
    .where(and(eq(schema.oauthRefreshToken.sessionId, sessionId), stillValid))
    .returning({ id: schema.oauthRefreshToken.id });

  return revoked.length;
}

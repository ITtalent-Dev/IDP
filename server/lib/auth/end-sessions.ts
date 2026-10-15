import { and, eq, isNotNull } from "drizzle-orm";
import { auth } from "../auth";
import { db, schema } from "../db/index";

export async function endUserSessions(userId: string) {
  await auth.api.endUserSessions({ body: { userId } });
}

export async function endSessions(sessionIds: string[]) {
  await auth.api.endSessions({ body: { sessionIds } });
}

export async function sessionIdsBoundToOrganization(organizationId: string) {
  const [active, refresh, access] = await Promise.all([
    db
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(eq(schema.session.activeOrganizationId, organizationId)),
    db
      .select({ id: schema.oauthRefreshToken.sessionId })
      .from(schema.oauthRefreshToken)
      .where(
        and(eq(schema.oauthRefreshToken.referenceId, organizationId), isNotNull(schema.oauthRefreshToken.sessionId)),
      ),
    db
      .select({ id: schema.oauthAccessToken.sessionId })
      .from(schema.oauthAccessToken)
      .where(
        and(eq(schema.oauthAccessToken.referenceId, organizationId), isNotNull(schema.oauthAccessToken.sessionId)),
      ),
  ]);

  return [...new Set([...active, ...refresh, ...access].map((row) => row.id!))];
}

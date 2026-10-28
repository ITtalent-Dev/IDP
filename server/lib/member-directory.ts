import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { auth, ISSUER } from "./auth";
import { APPS } from "./apps";
import { db, schema } from "./db/index";
import { ACCESS_CLAIM, ORGANIZATION_CLAIM, type AccessMap } from "./auth/access-claims";
import { APP_IDS, MANDATORY_ACTION } from "../../shared/permissions";

export const MAX_MEMBER_IDS = 100;

export const memberDirectoryQuerySchema = z.object({
  ids: z
    .string()
    .transform((raw) => [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))])
    .pipe(z.array(z.string().max(64)).min(1).max(MAX_MEMBER_IDS)),
});

export interface MemberSummary {
  id: string;
  name: string;
}

const appAudiences = () => APP_IDS.map((id) => APPS[id].resource);

export async function organizationFromAppToken(token: string): Promise<string | null> {
  let payload: JWTPayload;

  try {
    const jwks = await auth.api.getJwks();

    ({ payload } = await jwtVerify(token, createLocalJWKSet(jwks), { issuer: ISSUER, audience: appAudiences() }));
  } catch {
    return null;
  }

  const organizationId = payload[ORGANIZATION_CLAIM];
  const access = payload[ACCESS_CLAIM] as AccessMap | undefined;

  if (typeof organizationId !== "string" || !payload.sub) return null;
  if (!access?.[organizationId]?.includes(MANDATORY_ACTION)) return null;

  return organizationId;
}

export async function memberSummaries(organizationId: string, userIds: string[]): Promise<MemberSummary[]> {
  return db
    .select({ id: schema.user.id, name: schema.user.name })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, organizationId), inArray(schema.user.id, userIds)));
}

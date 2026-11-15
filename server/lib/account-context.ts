import { eq } from "drizzle-orm";
import { auth } from "./auth";
import { db, schema } from "./db/index";
import { APPS } from "./apps";
import { effectivePlatformAccess } from "./auth/access-claims";
import { twoFactorStatus } from "./auth/two-factor-policy";
import { isAppId } from "../../shared/permissions";
import { logoUrl, logoVersion } from "./org-profile";

export async function userMemberships(userId: string) {
  const rows = await db
    .select({
      id: schema.organization.id,
      name: schema.organization.name,
      slug: schema.organization.slug,
      apps: schema.organization.apps,
      requireTwoFactor: schema.organization.requireTwoFactor,
      logoVersion,
      role: schema.member.role,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(eq(schema.member.userId, userId))
    .orderBy(schema.organization.name);

  return rows.map(({ logoVersion: version, ...o }) => ({
    ...o,
    logoUrl: logoUrl(o.id, version),
    requireTwoFactor: o.requireTwoFactor === true,
    apps: (o.apps ?? []).filter(isAppId).map((id) => ({ id, label: APPS[id].label, url: APPS[id].url })),
  }));
}

export async function organizationsGrantingPlatform(userId: string) {
  const [memberships, access] = await Promise.all([userMemberships(userId), effectivePlatformAccess(userId)]);

  return memberships.filter((o) => access[o.id]);
}

export const hasOrganizationPermission = (
  headers: Headers,
  organizationId: string,
  permissions: Record<string, string[]>,
) =>
  auth.api
    .hasPermission({ headers, body: { organizationId, permissions } as never })
    .then((r) => (r as { success?: boolean }).success === true)
    .catch(() => false);

const MANAGEMENT_PERMISSIONS: Record<string, string[]>[] = [
  { member: ["update"] },
  { invitation: ["create"] },
  { ac: ["create"] },
];

const CONNECTOR_PERMISSIONS: Record<string, string[]>[] = [
  { connector: ["create"] },
  { connector: ["update"] },
  { connector: ["delete"] },
];

const anyPermission = async (headers: Headers, organizationId: string, candidates: Record<string, string[]>[]) =>
  (
    await Promise.all(candidates.map((permissions) => hasOrganizationPermission(headers, organizationId, permissions)))
  ).some(Boolean);

export const canManageOrganization = (headers: Headers, organizationId: string) =>
  anyPermission(headers, organizationId, MANAGEMENT_PERMISSIONS);

export const canManageConnectors = (headers: Headers, organizationId: string) =>
  anyPermission(headers, organizationId, CONNECTOR_PERMISSIONS);

export async function accountContext(
  headers: Headers,
  userId: string,
  activeOrganizationId: string | null,
  impersonating: boolean,
) {
  const [organizations, twoFactor] = await Promise.all([userMemberships(userId), twoFactorStatus(userId)]);
  const active = organizations.find((o) => o.id === activeOrganizationId) ?? null;

  return {
    impersonating,
    twoFactor,
    organizations,
    active: active
      ? {
          ...active,
          canManage: await canManageOrganization(headers, active.id),
          canManageConnectors: await canManageConnectors(headers, active.id),
        }
      : null,
  };
}

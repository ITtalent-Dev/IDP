import { hasOrganizationPermission, userMemberships } from "../account-context";

export const canPairConnectors = (headers: Headers, organizationId: string) =>
  hasOrganizationPermission(headers, organizationId, { connector: ["create"] });

export async function pairingOrganizations(headers: Headers, userId: string) {
  const memberships = await userMemberships(userId);
  const allowed = await Promise.all(memberships.map((o) => canPairConnectors(headers, o.id)));

  return memberships
    .filter((_, i) => allowed[i])
    .map((o) => ({ id: o.id, name: o.name, slug: o.slug, logoUrl: o.logoUrl, apps: o.apps.map((a) => a.id) }));
}

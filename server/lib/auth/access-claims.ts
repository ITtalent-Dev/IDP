import { APIError } from "better-auth/api";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index";
import { env } from "../env";
import { APPS, appByResource } from "../apps";
import { CONNECTOR_METADATA_KEY, resolveConnectorForToken } from "../connectors/connectors";
import { APP_PERMISSIONS, CONNECTOR_KINDS, roles as staticRoles, type AppId } from "../../../shared/permissions";

export const ACCESS_CLAIM = `${env.CLAIMS_NAMESPACE}/access`;

export const IMPERSONATED_BY_CLAIM = `${env.CLAIMS_NAMESPACE}/impersonated_by`;

export const ORGANIZATION_CLAIM = `${env.CLAIMS_NAMESPACE}/org_id`;

export const ORGANIZATION_NAME_CLAIM = `${env.CLAIMS_NAMESPACE}/org_name`;

export const ORGANIZATION_COUNT_CLAIM = `${env.CLAIMS_NAMESPACE}/org_count`;

export const CONNECTOR_CLAIM = `${env.CLAIMS_NAMESPACE}/connector_id`;

export type AccessMap = Record<string, string[]>;

const parseRoles = (role: string) =>
  role
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

export async function effectiveAppAccess(userId: string, appId: AppId): Promise<AccessMap> {
  const memberships = await db
    .select({
      organizationId: schema.member.organizationId,
      role: schema.member.role,
      apps: schema.organization.apps,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(eq(schema.member.userId, userId));

  const eligible = memberships.filter((m) => (m.apps ?? []).includes(appId));

  if (!eligible.length) return {};

  const dynamicRoles = await db
    .select({
      organizationId: schema.organizationRole.organizationId,
      role: schema.organizationRole.role,
      permission: schema.organizationRole.permission,
    })
    .from(schema.organizationRole)
    .where(
      and(
        inArray(
          schema.organizationRole.organizationId,
          eligible.map((m) => m.organizationId),
        ),
        inArray(
          schema.organizationRole.role,
          eligible.flatMap((m) => parseRoles(m.role)),
        ),
      ),
    );

  const catalogue = new Set<string>(APP_PERMISSIONS[appId]);
  const access: AccessMap = {};

  for (const m of eligible) {
    const granted = new Set<string>();

    for (const role of parseRoles(m.role)) {
      const fixed = staticRoles[role as keyof typeof staticRoles];

      for (const action of (fixed?.statements as Record<string, readonly string[]> | undefined)?.[appId] ?? []) {
        granted.add(action);
      }

      for (const d of dynamicRoles) {
        if (d.organizationId !== m.organizationId || d.role !== role) continue;
        const perms = JSON.parse(d.permission) as Record<string, string[]>;

        for (const action of perms[appId] ?? []) granted.add(action);
      }
    }

    const actions = new Set([...granted].filter((a) => catalogue.has(a)));

    if (actions.has("access")) {
      access[m.organizationId] = APP_PERMISSIONS[appId].filter((a) => actions.has(a));
    }
  }

  return access;
}

interface TokenRequest {
  user?: { id: string; banned?: unknown } | null;
  resources?: string[];
  referenceId?: string;
  metadata?: Record<string, unknown>;
}

const connectorIdOf = (metadata: Record<string, unknown> | undefined) => {
  const value = metadata?.[CONNECTOR_METADATA_KEY];

  return typeof value === "string" && value ? value : null;
};

const CONNECTOR_REFUSALS = {
  unknown: "Unknown connector",
  revoked: "Connector is revoked",
  app_disabled: "The organization no longer has access to this application",
} as const;

export async function buildConnectorClaims(connectorId: string, resources: string[] = []) {
  const binding = await resolveConnectorForToken(connectorId);

  if (!binding.ok) {
    throw new APIError("FORBIDDEN", { error: "access_denied", error_description: CONNECTOR_REFUSALS[binding.reason] });
  }

  const { app, action } = CONNECTOR_KINDS[binding.kind];

  if (resources.length !== 1 || resources[0] !== APPS[app].resource) {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_target",
      error_description: `A ${binding.kind} connector can only request the ${APPS[app].label} resource`,
    });
  }

  return {
    [ACCESS_CLAIM]: { [binding.organizationId]: [action] },
    [ORGANIZATION_CLAIM]: binding.organizationId,
    [ORGANIZATION_NAME_CLAIM]: binding.organizationName,
    [CONNECTOR_CLAIM]: binding.connectorId,
  };
}

export async function buildAccessTokenClaims(info: TokenRequest): Promise<Record<string, unknown>> {
  const connectorId = connectorIdOf(info.metadata);

  if (connectorId) {
    if (info.user) {
      throw new APIError("FORBIDDEN", {
        error: "access_denied",
        error_description: "Connector clients cannot act for a user",
      });
    }

    return buildConnectorClaims(connectorId, info.resources);
  }

  if (!info.user) return {};

  return buildUserClaims({ ...info, user: info.user });
}

async function buildUserClaims(info: TokenRequest & { user: NonNullable<TokenRequest["user"]> }) {
  if (info.user.banned === true) {
    throw new APIError("FORBIDDEN", { error: "access_denied", error_description: "User is banned" });
  }

  const apps = (info.resources ?? []).map(appByResource);

  if (apps.length !== 1 || !apps[0]) {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_target",
      error_description: "Exactly one known resource must be requested",
    });
  }

  const access = await effectiveAppAccess(info.user.id, apps[0].id);

  if (!Object.keys(access).length) {
    throw new APIError("FORBIDDEN", {
      error: "access_denied",
      error_description: "No organization grants access to this application",
    });
  }

  const granting = Object.keys(access);
  const organizationId = info.referenceId ?? (granting.length === 1 ? granting[0] : undefined);

  if (!organizationId) {
    throw new APIError("FORBIDDEN", {
      error: "access_denied",
      error_description: "An organization must be selected",
    });
  }

  const permissions = access[organizationId];

  if (!permissions) {
    throw new APIError("FORBIDDEN", {
      error: "access_denied",
      error_description: "The selected organization does not grant access to this application",
    });
  }

  const [[user], [organization]] = await Promise.all([
    db
      .select({ name: schema.user.name, email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, info.user.id))
      .limit(1),
    db
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, organizationId))
      .limit(1),
  ]);

  return {
    [ACCESS_CLAIM]: { [organizationId]: permissions },
    [ORGANIZATION_CLAIM]: organizationId,
    [ORGANIZATION_NAME_CLAIM]: organization?.name ?? null,
    [ORGANIZATION_COUNT_CLAIM]: granting.length,
    name: user?.name ?? null,
    email: user?.email ?? null,
  };
}

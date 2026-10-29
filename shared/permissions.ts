import { createAccessControl } from "better-auth/plugins/access";

export const APP_PERMISSIONS = {
  datahub: ["access", "import", "import-read"],
  app: ["access", "admin"],
} as const;

export type AppId = keyof typeof APP_PERMISSIONS;

export const APP_IDS = Object.keys(APP_PERMISSIONS) as AppId[];

export const APP_LABELS: Record<AppId, string> = {
  datahub: "Data hub",
  app: "App",
};

export const ORG_PERMISSIONS = {
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  ac: ["create", "read", "update", "delete"],
  connector: ["create", "update", "delete"],
} as const;

export const statement = {
  ...ORG_PERMISSIONS,
  ...APP_PERMISSIONS,
} as const;

export const ac = createAccessControl(statement);

export const owner = ac.newRole({
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  ac: ["create", "read", "update", "delete"],
  connector: ["create", "update", "delete"],
  datahub: ["access", "import", "import-read"],
  app: ["access", "admin"],
});

export const member = ac.newRole({
  ac: ["read"],
});

export const roles = { owner, member };

export const STATIC_ROLES = Object.keys(roles) as (keyof typeof roles)[];

export const MANDATORY_ACTION = "access";

export const CONNECTOR_KINDS = {
  import: { app: "datahub", action: "import" },
  impression: { app: "app", action: "print" },
} as const satisfies Record<string, { app: AppId; action: string }>;

export type ConnectorKind = keyof typeof CONNECTOR_KINDS;

export const CONNECTOR_KIND_IDS = Object.keys(CONNECTOR_KINDS) as ConnectorKind[];

export const DEFAULT_CONNECTOR_KIND: ConnectorKind = "import";

export const CONNECTOR_SCOPES = [...new Set(CONNECTOR_KIND_IDS.map((kind) => CONNECTOR_KINDS[kind].action))];

export type PermissionMap = Partial<Record<string, string[]>>;

export const isAppId = (value: string): value is AppId => value in APP_PERMISSIONS;

export function normalizeRolePermissions(perms: PermissionMap): PermissionMap {
  const out: PermissionMap = {};

  for (const [resource, actions] of Object.entries(perms)) {
    if (!isAppId(resource)) {
      out[resource] = actions;
      continue;
    }

    const known = APP_PERMISSIONS[resource].filter((action) => actions?.includes(action));

    if (known.length) out[resource] = known.includes(MANDATORY_ACTION) ? known : [MANDATORY_ACTION, ...known];
  }

  return out;
}

export function appsOutsideCeiling(perms: PermissionMap, allowedApps: readonly string[]): AppId[] {
  return Object.entries(perms)
    .filter(([resource, actions]) => isAppId(resource) && actions?.length && !allowedApps.includes(resource))
    .map(([resource]) => resource as AppId);
}

import type { PermissionState } from "./types";

export interface OrgMember {
  kind: "member";
  id: string;
  role: string;
  createdAt: string | Date;
  userId: string;
  user: { id: string; name: string; email: string };
  twoFactor: boolean;
}

export interface OrgInvitation {
  kind: "invitation";
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string | Date;
}

export type PeopleFilter = "all" | "members" | "pending" | "no2fa";

export interface PeoplePage {
  rows: (OrgMember | OrgInvitation)[];
  total: number;
  counts: { members: number; pending: number; withoutTwoFactor: number };
}

export interface DynamicRole {
  id: string;
  role: string;
  permission: PermissionState;
}

export interface ManagedOrganization {
  id: string;
  name: string;
  slug: string;
  apps: string[];
  requireTwoFactor: boolean;
  logoUrl: string | null;
}

export interface OrgRights {
  members: boolean;
  invite: boolean;
  roles: boolean;
  settings: boolean;
}

export const parsePermission = (p: unknown): PermissionState =>
  typeof p === "string" ? (JSON.parse(p) as PermissionState) : ((p ?? {}) as PermissionState);

export interface OrgConnector {
  id: string;
  name: string;
  kind: string;
  clientId: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdBy: { id: string; name: string | null; email: string | null } | null;
}

export interface ConnectorPage {
  connectors: OrgConnector[];
  total: number;
  active: number;
}

export interface PairingOrganization {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  apps: string[];
}

import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema";
import type { ConnectorKind } from "../../../shared/permissions";

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id"),
    impersonatedBy: text("impersonated_by"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    organizationId: text("organization_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  },
  (t) => [
    index("audit_log_created_at_idx").on(t.createdAt),
    index("audit_log_actor_idx").on(t.actorId),
    index("audit_log_organization_idx").on(t.organizationId),
    index("audit_log_action_idx").on(t.action),
  ],
);

export const deletedAccountArchive = pgTable(
  "deleted_account_archive",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    reason: text("reason").notNull(),
    accountCreatedAt: timestamp("account_created_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    connections: jsonb("connections").$type<Record<string, unknown>>().default({}).notNull(),
  },
  (t) => [
    index("deleted_account_archive_email_idx").on(t.email),
    index("deleted_account_archive_expires_idx").on(t.expiresAt),
  ],
);

export const knownDevice = pgTable(
  "known_device",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    deviceHash: text("device_hash").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("known_device_user_hash_idx").on(t.userId, t.deviceHash)],
);

export interface ConnectorPublicKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  alg: "ES256";
  use: "sig";
  kid: string;
}

export const connector = pgTable(
  "connector",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    oauthClientId: text("oauth_client_id").notNull().unique(),
    kind: text("kind").$type<ConnectorKind>().default("import").notNull(),
    name: text("name").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [index("connector_organization_idx").on(t.organizationId)],
);

export const connectorPairing = pgTable(
  "connector_pairing",
  {
    id: text("id").primaryKey(),
    deviceCodeHash: text("device_code_hash").notNull().unique(),
    userCode: text("user_code").notNull().unique(),
    publicKey: jsonb("public_key").$type<ConnectorPublicKey>().notNull(),
    requestedName: text("requested_name"),
    requestedKind: text("requested_kind").$type<ConnectorKind>().default("import").notNull(),
    status: text("status").$type<"pending" | "approved" | "denied" | "consumed">().default("pending").notNull(),
    pollInterval: integer("poll_interval").notNull(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    connectorId: text("connector_id").references(() => connector.id, { onDelete: "cascade" }),
    decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("connector_pairing_expires_idx").on(t.expiresAt)],
);

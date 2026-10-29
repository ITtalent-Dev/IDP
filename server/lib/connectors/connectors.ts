import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "../db/index";
import { APPS } from "../apps";
import { audit } from "../support/audit";
import type { ConnectorPublicKey } from "../db/app-schema";
import { CONNECTOR_KINDS, type ConnectorKind } from "../../../shared/permissions";

export const CONNECTOR_SOFTWARE_ID = "auth-service:connector";

export const CONNECTOR_METADATA_KEY = "connector_id";

export const connectorNameSchema = z.string().trim().min(1).max(80);

export const renameConnectorSchema = z.object({ name: connectorNameSchema });

export const listConnectorsSchema = z.object({
  status: z.enum(["all", "active", "revoked"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type Executor = typeof db | Transaction;

interface Actor {
  actorId: string;
  impersonatedBy: string | null;
}

export async function createConnector(
  tx: Executor,
  input: {
    organizationId: string;
    kind: ConnectorKind;
    name: string;
    publicKey: ConnectorPublicKey;
    createdBy: string;
  },
) {
  const connectorId = randomUUID();
  const { app, action } = CONNECTOR_KINDS[input.kind];
  const oauthClientId = `connector-${randomUUID()}`;
  const now = new Date();

  await tx.insert(schema.oauthClient).values({
    id: randomUUID(),
    clientId: oauthClientId,
    clientSecret: null,
    disabled: false,
    skipConsent: true,
    name: input.name,
    softwareId: CONNECTOR_SOFTWARE_ID,
    scopes: [action],
    clientCredentialsScopes: [action],
    redirectUris: [],
    grantTypes: ["client_credentials"],
    responseTypes: [],
    tokenEndpointAuthMethod: "private_key_jwt",
    jwks: JSON.stringify({ keys: [input.publicKey] }),
    metadata: { [CONNECTOR_METADATA_KEY]: connectorId },
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(schema.oauthClientResource).values({
    id: randomUUID(),
    clientId: oauthClientId,
    resourceId: APPS[app].resource,
    createdAt: now,
  });
  const [connector] = await tx
    .insert(schema.connector)
    .values({
      id: connectorId,
      organizationId: input.organizationId,
      oauthClientId,
      kind: input.kind,
      name: input.name,
      createdBy: input.createdBy,
      createdAt: now,
    })
    .returning();

  return connector!;
}

const STATUS_FILTERS = {
  all: undefined,
  active: isNull(schema.connector.revokedAt),
  revoked: isNotNull(schema.connector.revokedAt),
};

export async function listConnectors(organizationId: string, query: z.infer<typeof listConnectorsSchema>) {
  const where = and(eq(schema.connector.organizationId, organizationId), STATUS_FILTERS[query.status]);
  const [rows, [total], [active]] = await Promise.all([
    db
      .select({
        id: schema.connector.id,
        name: schema.connector.name,
        kind: schema.connector.kind,
        clientId: schema.connector.oauthClientId,
        createdAt: schema.connector.createdAt,
        lastUsedAt: schema.connector.lastUsedAt,
        revokedAt: schema.connector.revokedAt,
        createdById: schema.user.id,
        createdByName: schema.user.name,
        createdByEmail: schema.user.email,
      })
      .from(schema.connector)
      .leftJoin(schema.user, eq(schema.user.id, schema.connector.createdBy))
      .where(where)
      .orderBy(desc(schema.connector.createdAt), desc(schema.connector.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(schema.connector).where(where),
    db
      .select({ n: count() })
      .from(schema.connector)
      .where(and(eq(schema.connector.organizationId, organizationId), isNull(schema.connector.revokedAt))),
  ]);

  return {
    connectors: rows.map(({ createdById, createdByName, createdByEmail, ...c }) => ({
      ...c,
      status: c.revokedAt ? ("revoked" as const) : ("active" as const),
      createdBy: createdById ? { id: createdById, name: createdByName, email: createdByEmail } : null,
    })),
    total: total?.n ?? 0,
    active: active?.n ?? 0,
  };
}

const findConnector = (organizationId: string, connectorId: string) =>
  db
    .select()
    .from(schema.connector)
    .where(and(eq(schema.connector.id, connectorId), eq(schema.connector.organizationId, organizationId)))
    .limit(1)
    .then(([row]) => row);

type ManagementResult = { ok: true } | { ok: false; code: "CONNECTOR_NOT_FOUND" | "CONNECTOR_REVOKED" };

export async function renameConnector(
  organizationId: string,
  connectorId: string,
  name: string,
  actor: Actor,
): Promise<ManagementResult> {
  const connector = await findConnector(organizationId, connectorId);

  if (!connector) return { ok: false, code: "CONNECTOR_NOT_FOUND" };
  if (connector.revokedAt) return { ok: false, code: "CONNECTOR_REVOKED" };
  if (connector.name === name) return { ok: true };

  await db.transaction(async (tx) => {
    await tx.update(schema.connector).set({ name }).where(eq(schema.connector.id, connector.id));
    await tx
      .update(schema.oauthClient)
      .set({ name, updatedAt: new Date() })
      .where(eq(schema.oauthClient.clientId, connector.oauthClientId));
  });
  await audit({
    ...actor,
    action: "connector.renamed",
    targetType: "connector",
    targetId: connector.id,
    organizationId,
    metadata: { from: connector.name, to: name },
  });

  return { ok: true };
}

export async function revokeConnector(
  organizationId: string,
  connectorId: string,
  actor: Actor,
): Promise<ManagementResult> {
  const connector = await findConnector(organizationId, connectorId);

  if (!connector) return { ok: false, code: "CONNECTOR_NOT_FOUND" };
  if (connector.revokedAt) return { ok: false, code: "CONNECTOR_REVOKED" };

  await db.transaction(async (tx) => {
    await tx
      .update(schema.connector)
      .set({ revokedAt: new Date(), revokedBy: actor.actorId })
      .where(eq(schema.connector.id, connector.id));
    await tx.delete(schema.oauthClient).where(eq(schema.oauthClient.clientId, connector.oauthClientId));
  });
  await audit({
    ...actor,
    action: "connector.revoked",
    targetType: "connector",
    targetId: connector.id,
    organizationId,
    metadata: { name: connector.name },
  });

  return { ok: true };
}

export async function deleteOrganizationConnectorClients(tx: Executor, organizationId: string) {
  const clients = await tx
    .select({ clientId: schema.connector.oauthClientId })
    .from(schema.connector)
    .where(eq(schema.connector.organizationId, organizationId));

  if (!clients.length) return;
  await tx.delete(schema.oauthClient).where(
    inArray(
      schema.oauthClient.clientId,
      clients.map((c) => c.clientId),
    ),
  );
}

export type ConnectorBinding =
  | { ok: true; connectorId: string; kind: ConnectorKind; organizationId: string; organizationName: string }
  | { ok: false; reason: "unknown" | "revoked" | "app_disabled" };

export async function resolveConnectorForToken(connectorId: string): Promise<ConnectorBinding> {
  const [row] = await db
    .select({
      id: schema.connector.id,
      kind: schema.connector.kind,
      revokedAt: schema.connector.revokedAt,
      organizationId: schema.organization.id,
      organizationName: schema.organization.name,
      apps: schema.organization.apps,
    })
    .from(schema.connector)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.connector.organizationId))
    .where(eq(schema.connector.id, connectorId))
    .limit(1);

  if (!row) return { ok: false, reason: "unknown" };
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (!(row.apps ?? []).includes(CONNECTOR_KINDS[row.kind].app)) return { ok: false, reason: "app_disabled" };

  await db.update(schema.connector).set({ lastUsedAt: new Date() }).where(eq(schema.connector.id, row.id));

  return {
    ok: true,
    connectorId: row.id,
    kind: row.kind,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
  };
}

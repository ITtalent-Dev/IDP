import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq, gt, sql } from "drizzle-orm";
import { db, schema } from "../db/index";
import { env } from "../env";
import { APPS } from "../apps";
import { audit } from "../support/audit";
import {
  CONNECTOR_KIND_IDS,
  CONNECTOR_KINDS,
  DEFAULT_CONNECTOR_KIND,
  type ConnectorKind,
} from "../../../shared/permissions";
import { connectorPublicKeySchema, normalizePublicKey } from "./keys";
import { createConnector, connectorNameSchema } from "./connectors";

export const PAIRING_TTL_SECONDS = 10 * 60;

export const POLL_INTERVAL_SECONDS = 5;

const SLOW_DOWN_INCREMENT_SECONDS = 5;

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

const USER_CODE_LENGTH = 8;

export const pairingRequestSchema = z.object({
  publicKey: connectorPublicKeySchema,
  name: connectorNameSchema.optional(),
  kind: z.enum(CONNECTOR_KIND_IDS as [ConnectorKind, ...ConnectorKind[]]).default(DEFAULT_CONNECTOR_KIND),
});

export const pairingTokenSchema = z.object({ deviceCode: z.string().min(1).max(200) });

export const userCodeSchema = z
  .string()
  .trim()
  .transform((code) => code.toUpperCase().replace(/[^A-Z]/g, ""))
  .pipe(z.string().length(USER_CODE_LENGTH));

export const pairingDecisionSchema = z.object({
  userCode: userCodeSchema,
  organizationId: z.string().min(1),
  name: connectorNameSchema.optional(),
});

const hashDeviceCode = (deviceCode: string) => createHash("sha256").update(deviceCode).digest("hex");

const generateUserCode = () =>
  Array.from({ length: USER_CODE_LENGTH }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join("");

export const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export const verificationUri = () => `${env.AUTH_BASE_URL}/connectors/pair`;

const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === "23505";

export type PairingRequestResult =
  | { ok: false; code: "INVALID_PUBLIC_KEY" }
  | {
      ok: true;
      pairing: {
        deviceCode: string;
        userCode: string;
        verificationUri: string;
        verificationUriComplete: string;
        expiresIn: number;
        interval: number;
      };
    };

export async function requestPairing(input: z.infer<typeof pairingRequestSchema>): Promise<PairingRequestResult> {
  const publicKey = normalizePublicKey(input.publicKey);

  if (!publicKey) return { ok: false, code: "INVALID_PUBLIC_KEY" };
  const deviceCode = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + PAIRING_TTL_SECONDS * 1000);

  for (let attempt = 0; ; attempt++) {
    const userCode = generateUserCode();

    try {
      await db.insert(schema.connectorPairing).values({
        id: randomUUID(),
        deviceCodeHash: hashDeviceCode(deviceCode),
        userCode,
        publicKey,
        requestedName: input.name ?? null,
        requestedKind: input.kind,
        pollInterval: POLL_INTERVAL_SECONDS,
        expiresAt,
      });
    } catch (error) {
      if (isUniqueViolation(error) && attempt < 3) continue;
      throw error;
    }

    const formatted = formatUserCode(userCode);
    const complete = new URL(verificationUri());

    complete.searchParams.set("code", formatted);

    return {
      ok: true,
      pairing: {
        deviceCode,
        userCode: formatted,
        verificationUri: verificationUri(),
        verificationUriComplete: complete.toString(),
        expiresIn: PAIRING_TTL_SECONDS,
        interval: POLL_INTERVAL_SECONDS,
      },
    };
  }
}

export type PollError = "authorization_pending" | "slow_down" | "expired_token" | "access_denied" | "invalid_grant";

export interface ConnectorCredentials {
  clientId: string;
  issuer: string;
  tokenEndpoint: string;
  resource: string;
}

export type PollResult = { ok: true; credentials: ConnectorCredentials } | { ok: false; error: PollError };

const credentialsFor = (clientId: string, kind: ConnectorKind): ConnectorCredentials => ({
  clientId,
  issuer: `${env.AUTH_BASE_URL}/api/auth`,
  tokenEndpoint: `${env.AUTH_BASE_URL}/api/auth/oauth2/token`,
  resource: APPS[CONNECTOR_KINDS[kind].app].resource,
});

async function consumeApproved(pairingId: string): Promise<PollResult> {
  const [consumed] = await db
    .update(schema.connectorPairing)
    .set({ status: "consumed" })
    .where(and(eq(schema.connectorPairing.id, pairingId), eq(schema.connectorPairing.status, "approved")))
    .returning({ connectorId: schema.connectorPairing.connectorId });

  if (!consumed?.connectorId) return { ok: false, error: "invalid_grant" };
  const [connector] = await db
    .select({
      oauthClientId: schema.connector.oauthClientId,
      kind: schema.connector.kind,
      revokedAt: schema.connector.revokedAt,
    })
    .from(schema.connector)
    .where(eq(schema.connector.id, consumed.connectorId))
    .limit(1);

  if (!connector || connector.revokedAt) return { ok: false, error: "access_denied" };

  return { ok: true, credentials: credentialsFor(connector.oauthClientId, connector.kind) };
}

export async function pollPairing(deviceCode: string, now = new Date()): Promise<PollResult> {
  const [pairing] = await db
    .select()
    .from(schema.connectorPairing)
    .where(eq(schema.connectorPairing.deviceCodeHash, hashDeviceCode(deviceCode)))
    .limit(1);

  if (!pairing) return { ok: false, error: "invalid_grant" };

  switch (pairing.status) {
    case "approved":
      return consumeApproved(pairing.id);
    case "denied":
      return { ok: false, error: "access_denied" };
    case "consumed":
      return { ok: false, error: "invalid_grant" };
  }

  if (pairing.expiresAt <= now) return { ok: false, error: "expired_token" };
  const tooEarly =
    pairing.lastPolledAt !== null && now.getTime() - pairing.lastPolledAt.getTime() < pairing.pollInterval * 1000;

  await db
    .update(schema.connectorPairing)
    .set({
      lastPolledAt: now,
      ...(tooEarly
        ? { pollInterval: sql`${schema.connectorPairing.pollInterval} + ${SLOW_DOWN_INCREMENT_SECONDS}` }
        : {}),
    })
    .where(eq(schema.connectorPairing.id, pairing.id));

  return { ok: false, error: tooEarly ? "slow_down" : "authorization_pending" };
}

const pendingPairing = (userCode: string) =>
  db
    .select()
    .from(schema.connectorPairing)
    .where(
      and(
        eq(schema.connectorPairing.userCode, userCode),
        eq(schema.connectorPairing.status, "pending"),
        gt(schema.connectorPairing.expiresAt, new Date()),
      ),
    )
    .limit(1)
    .then(([row]) => row);

export async function describePairing(userCode: string) {
  const pairing = await pendingPairing(userCode);

  return pairing
    ? {
        userCode: formatUserCode(pairing.userCode),
        name: pairing.requestedName,
        kind: pairing.requestedKind,
        app: CONNECTOR_KINDS[pairing.requestedKind].app,
        expiresAt: pairing.expiresAt,
      }
    : null;
}

interface Actor {
  actorId: string;
  impersonatedBy: string | null;
}

export type DecisionFailure = "PAIRING_NOT_FOUND" | "ORGANIZATION_NOT_FOUND" | "APP_NOT_ENABLED" | "NAME_REQUIRED";

export type DecisionResult<T> = ({ ok: true } & T) | { ok: false; code: DecisionFailure };

export async function organizationAllowsConnectors(organizationId: string, kind: ConnectorKind) {
  const [org] = await db
    .select({ apps: schema.organization.apps })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);

  if (!org) return "ORGANIZATION_NOT_FOUND" as const;

  return (org.apps ?? []).includes(CONNECTOR_KINDS[kind].app) ? null : ("APP_NOT_ENABLED" as const);
}

export async function approvePairing(
  input: z.infer<typeof pairingDecisionSchema>,
  actor: Actor,
): Promise<DecisionResult<{ connectorId: string; name: string; kind: ConnectorKind }>> {
  const result = await db.transaction(
    async (tx): Promise<DecisionResult<{ connectorId: string; name: string; kind: ConnectorKind }>> => {
      const [pairing] = await tx
        .select()
        .from(schema.connectorPairing)
        .where(
          and(
            eq(schema.connectorPairing.userCode, input.userCode),
            eq(schema.connectorPairing.status, "pending"),
            gt(schema.connectorPairing.expiresAt, new Date()),
          ),
        )
        .for("update")
        .limit(1);

      if (!pairing) return { ok: false, code: "PAIRING_NOT_FOUND" };
      const blocker = await organizationAllowsConnectors(input.organizationId, pairing.requestedKind);

      if (blocker) return { ok: false, code: blocker };
      const name = input.name ?? pairing.requestedName;

      if (!name) return { ok: false, code: "NAME_REQUIRED" };
      const connector = await createConnector(tx, {
        organizationId: input.organizationId,
        kind: pairing.requestedKind,
        name,
        publicKey: pairing.publicKey,
        createdBy: actor.actorId,
      });

      await tx
        .update(schema.connectorPairing)
        .set({ status: "approved", connectorId: connector.id, decidedBy: actor.actorId })
        .where(eq(schema.connectorPairing.id, pairing.id));

      return { ok: true, connectorId: connector.id, name, kind: pairing.requestedKind };
    },
  );

  if (result.ok) {
    await audit({
      ...actor,
      action: "connector.paired",
      targetType: "connector",
      targetId: result.connectorId,
      organizationId: input.organizationId,
      metadata: { name: result.name, kind: result.kind },
    });
  }

  return result;
}

export async function denyPairing(
  input: Pick<z.infer<typeof pairingDecisionSchema>, "userCode" | "organizationId">,
  actor: Actor,
): Promise<DecisionResult<object>> {
  const [denied] = await db
    .update(schema.connectorPairing)
    .set({ status: "denied", decidedBy: actor.actorId })
    .where(
      and(
        eq(schema.connectorPairing.userCode, input.userCode),
        eq(schema.connectorPairing.status, "pending"),
        gt(schema.connectorPairing.expiresAt, new Date()),
      ),
    )
    .returning({ id: schema.connectorPairing.id, name: schema.connectorPairing.requestedName });

  if (!denied) return { ok: false, code: "PAIRING_NOT_FOUND" };
  await audit({
    ...actor,
    action: "connector.pairing.denied",
    targetType: "connector_pairing",
    targetId: denied.id,
    organizationId: input.organizationId,
    metadata: { name: denied.name },
  });

  return { ok: true };
}

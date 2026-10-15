import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { db, pool, schema } from "./db/index";
import { env } from "./env";
import { sendEmailInBackground } from "./email/mailer";
import { accountDeletedTemplate, inactivityWarningTemplate } from "./email/templates";
import { soleOwnedOrganizations } from "./org-ownership";
import { audit } from "./support/audit";
import { endUserSessions } from "./auth/end-sessions";
import { logger } from "./support/logger";

const DAY = 24 * 60 * 60 * 1000;

export const RETENTION = {
  auditLogDays: 365,
  knownDeviceDays: 400,
  archiveDays: 365,
  inactivityDays: 3 * 365,
  inactivityWarningDays: 30,
  rateLimitDays: 1,
} as const;

export type DeletionReason = "self" | "admin" | "inactivity";

const DELETED_NAME = "Utilisateur supprimé";
const LOCK_KEY = "auth-service:retention";

const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * DAY);

export async function recordActivity(session: { userId: string; impersonatedBy?: string | null }) {
  if (session.impersonatedBy) return;
  await db
    .update(schema.user)
    .set({ lastActiveAt: new Date(), inactivityWarnedAt: null })
    .where(eq(schema.user.id, session.userId));
}

export async function pseudonymizeUser(
  userId: string,
  reason: DeletionReason,
  actor: { actorId: string | null; impersonatedBy?: string | null },
) {
  const now = new Date();
  const sessions = await db
    .select({
      createdAt: schema.session.createdAt,
      ipAddress: schema.session.ipAddress,
      userAgent: schema.session.userAgent,
      openedBySupport: sql<boolean>`${schema.session.impersonatedBy} is not null`,
    })
    .from(schema.session)
    .where(eq(schema.session.userId, userId));

  await endUserSessions(userId);

  const email = await db.transaction(async (tx) => {
    const [user] = await tx
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        createdAt: schema.user.createdAt,
      })
      .from(schema.user)
      .where(and(eq(schema.user.id, userId), isNull(schema.user.deletedAt)))
      .for("update")
      .limit(1);

    if (!user) return null;

    const devices = await tx
      .select({
        userAgent: schema.knownDevice.userAgent,
        firstSeenAt: schema.knownDevice.createdAt,
        lastSeenAt: schema.knownDevice.lastSeenAt,
      })
      .from(schema.knownDevice)
      .where(eq(schema.knownDevice.userId, userId));

    await tx.insert(schema.deletedAccountArchive).values({
      id: randomUUID(),
      userId,
      name: user.name,
      email: user.email,
      reason,
      accountCreatedAt: user.createdAt,
      deletedAt: now,
      expiresAt: new Date(now.getTime() + RETENTION.archiveDays * DAY),
      connections: { sessions, knownDevices: devices },
    });

    for (const table of [
      schema.session,
      schema.account,
      schema.twoFactor,
      schema.passkey,
      schema.knownDevice,
      schema.member,
      schema.oauthConsent,
      schema.oauthAccessToken,
      schema.oauthRefreshToken,
    ]) {
      await tx.delete(table).where(eq(table.userId, userId));
    }

    await tx
      .update(schema.user)
      .set({
        name: DELETED_NAME,
        email: `deleted-${userId}@deleted.invalid`,
        emailVerified: false,
        image: null,
        role: null,
        banned: true,
        banReason: "deleted",
        banExpires: null,
        twoFactorEnabled: false,
        hasPasskey: false,
        lastActiveAt: null,
        inactivityWarnedAt: null,
        deletedAt: now,
      })
      .where(eq(schema.user.id, userId));

    return user.email;
  });

  if (!email) return false;

  sendEmailInBackground(email, accountDeletedTemplate(reason));
  await audit({
    action: "user.delete",
    actorId: actor.actorId,
    impersonatedBy: actor.impersonatedBy ?? null,
    targetType: "user",
    targetId: userId,
    metadata: { by: reason },
  });

  return true;
}

const lastActivity = sql`coalesce(${schema.user.lastActiveAt}, ${schema.user.createdAt})`;
const activeCustomers = and(isNull(schema.user.deletedAt), or(isNull(schema.user.role), ne(schema.user.role, "admin")));

async function handleInactiveAccounts(now: Date) {
  const deletionCutoff = daysBefore(now, RETENTION.inactivityDays);
  const warningCutoff = daysBefore(now, RETENTION.inactivityDays - RETENTION.inactivityWarningDays);
  const warnedLongEnough = daysBefore(now, RETENTION.inactivityWarningDays);

  const toWarn = await db
    .select({ id: schema.user.id, email: schema.user.email, lastActivity: sql<Date>`${lastActivity}` })
    .from(schema.user)
    .where(and(activeCustomers, lt(lastActivity, warningCutoff), isNull(schema.user.inactivityWarnedAt)));
  const signInUrl = new URL("/sign-in", env.AUTH_BASE_URL).toString();

  for (const user of toWarn) {
    await db.update(schema.user).set({ inactivityWarnedAt: now }).where(eq(schema.user.id, user.id));
    const deletionDate = new Date(
      Math.max(
        now.getTime() + RETENTION.inactivityWarningDays * DAY,
        new Date(user.lastActivity).getTime() + RETENTION.inactivityDays * DAY,
      ),
    );

    sendEmailInBackground(user.email, inactivityWarningTemplate(signInUrl, deletionDate));
  }

  const toDelete = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(
      and(activeCustomers, lt(lastActivity, deletionCutoff), lte(schema.user.inactivityWarnedAt, warnedLongEnough)),
    );
  let deleted = 0;
  let kept = 0;

  for (const user of toDelete) {
    const owned = await soleOwnedOrganizations(user.id);

    if (owned.length) {
      kept++;
      await db.update(schema.user).set({ inactivityWarnedAt: now }).where(eq(schema.user.id, user.id));
      await audit({
        action: "user.inactivity.kept",
        targetType: "user",
        targetId: user.id,
        metadata: { soleOwnerOf: owned.map((o) => ({ id: o.id, name: o.name })) },
      });
      continue;
    }

    if (await pseudonymizeUser(user.id, "inactivity", { actorId: null })) deleted++;
  }

  return { warned: toWarn.length, deleted, kept };
}

export async function applyRetention(now = new Date()) {
  const purge = async <T>(query: Promise<T[]>) => (await query).length;
  const [
    auditLog,
    knownDevices,
    archives,
    invitations,
    verifications,
    sessions,
    rateLimits,
    connectorPairings,
    clientAssertions,
  ] = await Promise.all([
    purge(
      db
        .delete(schema.auditLog)
        .where(lt(schema.auditLog.createdAt, daysBefore(now, RETENTION.auditLogDays)))
        .returning({ id: schema.auditLog.id }),
    ),
    purge(
      db
        .delete(schema.knownDevice)
        .where(lt(schema.knownDevice.lastSeenAt, daysBefore(now, RETENTION.knownDeviceDays)))
        .returning({ id: schema.knownDevice.id }),
    ),
    purge(
      db
        .delete(schema.deletedAccountArchive)
        .where(lt(schema.deletedAccountArchive.expiresAt, now))
        .returning({ id: schema.deletedAccountArchive.id }),
    ),
    purge(
      db.delete(schema.invitation).where(lt(schema.invitation.expiresAt, now)).returning({ id: schema.invitation.id }),
    ),
    purge(
      db
        .delete(schema.verification)
        .where(lt(schema.verification.expiresAt, now))
        .returning({ id: schema.verification.id }),
    ),
    purge(db.delete(schema.session).where(lt(schema.session.expiresAt, now)).returning({ id: schema.session.id })),
    purge(
      db
        .delete(schema.rateLimit)
        .where(lt(schema.rateLimit.lastRequest, daysBefore(now, RETENTION.rateLimitDays).getTime()))
        .returning({ id: schema.rateLimit.id }),
    ),
    purge(
      db
        .delete(schema.connectorPairing)
        .where(lt(schema.connectorPairing.expiresAt, now))
        .returning({ id: schema.connectorPairing.id }),
    ),
    purge(
      db
        .delete(schema.oauthClientAssertion)
        .where(lt(schema.oauthClientAssertion.expiresAt, now))
        .returning({ id: schema.oauthClientAssertion.id }),
    ),
  ]);
  const accounts = await handleInactiveAccounts(now);

  return {
    auditLog,
    knownDevices,
    archives,
    invitations,
    verifications,
    sessions,
    rateLimits,
    connectorPairings,
    clientAssertions,
    accounts,
  };
}

export async function runRetentionOnce(now = new Date()) {
  const client = await pool.connect();

  try {
    const { rows } = await client.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtext($1)) as locked", [
      LOCK_KEY,
    ]);

    if (!rows[0]?.locked) return null;
    try {
      const result = await applyRetention(now);

      logger.info("retention applied", result);

      return result;
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

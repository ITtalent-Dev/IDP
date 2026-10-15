import { z } from "zod";
import { and, count, desc, eq, gt, ilike, or, sql, type SQL } from "drizzle-orm";
import { auth } from "../auth";
import { db, schema } from "../db/index";
import { APP_IDS, STATIC_ROLES } from "../../../shared/permissions";
import { INVITATION_TTL_SECONDS, sendInvitation } from "../auth/invitations";
import { audit } from "../support/audit";
import { endSessions, sessionIdsBoundToOrganization } from "../auth/end-sessions";
import { likePattern } from "../org-people";
import { logoUrl, logoVersion } from "../org-profile";
import { deleteOrganizationConnectorClients } from "../connectors/connectors";

export interface Actor {
  actorId: string;
  impersonatedBy: string | null;
  name: string;
}

const appsSchema = z.array(z.enum(APP_IDS as [string, ...string[]])).transform((a) => [...new Set(a)]);

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase letters, digits and dashes"),
  apps: appsSchema,
  ownerEmail: z.email().transform((e) => e.toLowerCase()),
});

export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  apps: appsSchema.optional(),
  requireTwoFactor: z.boolean().optional(),
});

export const invitationSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  role: z.string().trim().min(1).max(64).default("owner"),
});

const generateId = async (model: string) => {
  const ctx = await auth.$context;

  return ctx.generateId({ model }) || crypto.randomUUID();
};

const invitationExpiry = (from: Date) => new Date(from.getTime() + INVITATION_TTL_SECONDS * 1000);

export const listOrganizationsSchema = z.object({
  q: z.string().trim().default(""),
  app: z.enum(APP_IDS as [string, ...string[]]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function listOrganizations(query: z.infer<typeof listOrganizationsSchema>) {
  const filters: SQL[] = [];

  if (query.q) {
    filters.push(
      or(ilike(schema.organization.name, likePattern(query.q)), ilike(schema.organization.slug, likePattern(query.q)))!,
    );
  }

  if (query.app) filters.push(sql`${query.app} = any(${schema.organization.apps})`);
  const where = filters.length ? and(...filters) : undefined;

  const [organizations, [totals], [members], [pending]] = await Promise.all([
    db
      .select({
        id: schema.organization.id,
        name: schema.organization.name,
        slug: schema.organization.slug,
        apps: schema.organization.apps,
        createdAt: schema.organization.createdAt,
        logoVersion,
        memberCount: sql<number>`(select count(*)::int from "member" m where m.organization_id = "organization"."id")`,
        pendingInvitations: sql<number>`(select count(*)::int from "invitation" i where i.organization_id = "organization"."id" and i.status = 'pending' and i.expires_at > now())`,
      })
      .from(schema.organization)
      .where(where)
      .orderBy(desc(schema.organization.createdAt), desc(schema.organization.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(schema.organization).where(where),
    db
      .select({ n: count() })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
      .where(where),
    db
      .select({ n: count() })
      .from(schema.invitation)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.invitation.organizationId))
      .where(and(where, eq(schema.invitation.status, "pending"), gt(schema.invitation.expiresAt, new Date()))),
  ]);

  return {
    organizations: organizations.map(({ logoVersion: version, ...o }) => ({ ...o, logoUrl: logoUrl(o.id, version) })),
    total: totals?.n ?? 0,
    stats: { members: members?.n ?? 0, pendingInvitations: pending?.n ?? 0 },
  };
}

export async function getOrganizationDetail(id: string) {
  const [row] = await db
    .select({
      id: schema.organization.id,
      name: schema.organization.name,
      slug: schema.organization.slug,
      apps: schema.organization.apps,
      requireTwoFactor: schema.organization.requireTwoFactor,
      createdAt: schema.organization.createdAt,
      logoVersion,
    })
    .from(schema.organization)
    .where(eq(schema.organization.id, id))
    .limit(1);

  if (!row) return null;
  const { logoVersion: version, ...rest } = row;
  const organization = { ...rest, logoUrl: logoUrl(row.id, version) };
  const [[members], [pending], roles] = await Promise.all([
    db.select({ n: count() }).from(schema.member).where(eq(schema.member.organizationId, id)),
    db
      .select({ n: count() })
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.organizationId, id),
          eq(schema.invitation.status, "pending"),
          gt(schema.invitation.expiresAt, new Date()),
        ),
      ),
    organizationRoleNames(id),
  ]);

  return { organization, roles, counts: { members: members?.n ?? 0, pendingInvitations: pending?.n ?? 0 } };
}

export async function slugTaken(slug: string) {
  const [row] = await db.select({ n: count() }).from(schema.organization).where(eq(schema.organization.slug, slug));

  return (row?.n ?? 0) > 0;
}

export async function createOrganization(input: z.infer<typeof createOrganizationSchema>, actor: Actor) {
  const organizationId = await generateId("organization");
  const invitationId = await generateId("invitation");
  const now = new Date();

  const organization = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(schema.organization)
      .values({ id: organizationId, name: input.name, slug: input.slug, apps: input.apps, createdAt: now })
      .returning();

    await tx.insert(schema.invitation).values({
      id: invitationId,
      organizationId,
      email: input.ownerEmail,
      role: "owner",
      status: "pending",
      expiresAt: invitationExpiry(now),
      inviterId: actor.actorId,
      createdAt: now,
    });

    return org!;
  });

  sendInvitation({
    invitationId,
    email: input.ownerEmail,
    organizationName: organization.name,
    inviterName: actor.name,
  });

  await audit({
    ...actor,
    action: "organization.create",
    targetType: "organization",
    targetId: organization.id,
    organizationId: organization.id,
    metadata: { name: organization.name, slug: organization.slug, apps: organization.apps },
  });
  await audit({
    ...actor,
    action: "invitation.create",
    targetType: "invitation",
    targetId: invitationId,
    organizationId: organization.id,
    metadata: { email: input.ownerEmail, role: "owner" },
  });

  return { organization, invitationId };
}

export async function updateOrganization(id: string, input: z.infer<typeof updateOrganizationSchema>, actor: Actor) {
  const [before] = await db
    .select({
      name: schema.organization.name,
      apps: schema.organization.apps,
      requireTwoFactor: schema.organization.requireTwoFactor,
    })
    .from(schema.organization)
    .where(eq(schema.organization.id, id))
    .limit(1);

  if (!before) return null;

  const [organization] = await db
    .update(schema.organization)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.apps !== undefined ? { apps: input.apps } : {}),
      ...(input.requireTwoFactor !== undefined ? { requireTwoFactor: input.requireTwoFactor } : {}),
    })
    .where(eq(schema.organization.id, id))
    .returning();

  if (input.apps !== undefined) {
    await audit({
      ...actor,
      action: "organization.ceiling.update",
      targetType: "organization",
      targetId: id,
      organizationId: id,
      metadata: { from: before.apps ?? [], to: organization!.apps },
    });
  }

  if (input.requireTwoFactor !== undefined && input.requireTwoFactor !== (before.requireTwoFactor ?? false)) {
    await audit({
      ...actor,
      action: "organization.security.update",
      targetType: "organization",
      targetId: id,
      organizationId: id,
      metadata: { requireTwoFactor: input.requireTwoFactor },
    });
  }

  if (input.name !== undefined && input.name !== before.name) {
    await audit({
      ...actor,
      action: "organization.update",
      targetType: "organization",
      targetId: id,
      organizationId: id,
      metadata: { changes: { name: input.name } },
    });
  }

  return organization!;
}

export const deleteOrganizationSchema = z.object({ confirm: z.string() });

type DeletionResult = { ok: true } | { ok: false; code: "ORGANIZATION_NOT_FOUND" | "CONFIRMATION_MISMATCH" };

export async function deleteOrganization(
  id: string,
  confirm: string,
  actor: Omit<Actor, "name">,
): Promise<DeletionResult> {
  const [org] = await db
    .select({ name: schema.organization.name, slug: schema.organization.slug })
    .from(schema.organization)
    .where(eq(schema.organization.id, id))
    .limit(1);

  if (!org) return { ok: false, code: "ORGANIZATION_NOT_FOUND" };
  if (confirm !== org.slug) return { ok: false, code: "CONFIRMATION_MISMATCH" };

  await endSessions(await sessionIdsBoundToOrganization(id));

  const members = await db.transaction(async (tx) => {
    const [row] = await tx.select({ n: count() }).from(schema.member).where(eq(schema.member.organizationId, id));

    await tx
      .update(schema.session)
      .set({ activeOrganizationId: null })
      .where(eq(schema.session.activeOrganizationId, id));
    await tx.delete(schema.oauthRefreshToken).where(eq(schema.oauthRefreshToken.referenceId, id));
    await tx.delete(schema.oauthConsent).where(eq(schema.oauthConsent.referenceId, id));
    await deleteOrganizationConnectorClients(tx, id);
    await tx.delete(schema.organization).where(eq(schema.organization.id, id));

    return row?.n ?? 0;
  });

  await audit({
    ...actor,
    action: "organization.delete",
    targetType: "organization",
    targetId: id,
    organizationId: id,
    metadata: { name: org.name, slug: org.slug, members },
  });

  return { ok: true };
}

export async function organizationRoleNames(organizationId: string) {
  const rows = await db
    .select({ role: schema.organizationRole.role })
    .from(schema.organizationRole)
    .where(eq(schema.organizationRole.organizationId, organizationId))
    .orderBy(schema.organizationRole.role);

  return [...STATIC_ROLES, ...rows.map((r) => r.role)];
}

type InvitationResult =
  | { ok: true; invitationId: string }
  | { ok: false; code: "ORGANIZATION_NOT_FOUND" | "UNKNOWN_ROLE" | "ALREADY_MEMBER" };

export async function inviteToOrganization(
  id: string,
  email: string,
  role: string,
  actor: Actor,
): Promise<InvitationResult> {
  const [org] = await db.select().from(schema.organization).where(eq(schema.organization.id, id)).limit(1);

  if (!org) return { ok: false, code: "ORGANIZATION_NOT_FOUND" };
  if (!(await organizationRoleNames(id)).includes(role)) return { ok: false, code: "UNKNOWN_ROLE" };
  const [existing] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, id), eq(schema.user.email, email)))
    .limit(1);

  if (existing) return { ok: false, code: "ALREADY_MEMBER" };
  const invitationId = await generateId("invitation");
  const now = new Date();

  await db
    .update(schema.invitation)
    .set({ status: "canceled" })
    .where(
      and(
        eq(schema.invitation.organizationId, id),
        eq(schema.invitation.email, email),
        eq(schema.invitation.status, "pending"),
      ),
    );
  await db.insert(schema.invitation).values({
    id: invitationId,
    organizationId: id,
    email,
    role,
    status: "pending",
    expiresAt: invitationExpiry(now),
    inviterId: actor.actorId,
    createdAt: now,
  });
  sendInvitation({ invitationId, email, organizationName: org.name, inviterName: actor.name });
  await audit({
    ...actor,
    action: "invitation.create",
    targetType: "invitation",
    targetId: invitationId,
    organizationId: id,
    metadata: { email, role },
  });

  return { ok: true, invitationId };
}

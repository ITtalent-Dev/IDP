import { and, eq } from "drizzle-orm";
import { auth } from "../server/lib/auth";
import { db, pool, schema } from "../server/lib/db/index";
import { env } from "../server/lib/env";
import { runAsSystem } from "../server/lib/support/system-context";
import { INVITATION_TTL_SECONDS } from "../server/lib/auth/invitations";

if (env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true") {
  console.error("seed:demo is for local development only (set ALLOW_DEMO_SEED=true to override).");
  process.exit(1);
}

const PASSWORD = "auth-demo-7Rk2-quartz";
const [existingDemo] = await db.select().from(schema.user).where(eq(schema.user.email, "admin@demo.test"));
const [existingOrg] = await db.select().from(schema.organization).where(eq(schema.organization.slug, "acme"));

if (existingDemo && existingOrg) {
  console.log("Demo data already present, nothing to do.");
  await auth.$context;
  await pool.end();
  process.exit(0);
}

const ctx = await auth.$context;
const id = (model: string) => ctx.generateId({ model }) || crypto.randomUUID();

async function ensureUser(email: string, name: string, role?: string) {
  const [existing] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  const userId =
    existing?.id ??
    (await runAsSystem(() => auth.api.signUpEmail({ body: { email, password: PASSWORD, name } }))).user.id;

  await db
    .update(schema.user)
    .set({ emailVerified: true, ...(role ? { role } : {}) })
    .where(eq(schema.user.id, userId));

  return userId;
}

async function ensureOrg(slug: string, name: string, apps: string[]) {
  const [existing] = await db.select().from(schema.organization).where(eq(schema.organization.slug, slug));

  if (existing) return existing.id;
  const [org] = await db
    .insert(schema.organization)
    .values({ id: id("organization"), slug, name, apps, createdAt: new Date() })
    .returning();

  return org!.id;
}

async function ensureMember(organizationId: string, userId: string, role: string) {
  const [existing] = await db
    .select()
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)));

  if (!existing) {
    await db.insert(schema.member).values({ id: id("member"), organizationId, userId, role, createdAt: new Date() });
  }
}

async function ensureRole(organizationId: string, role: string, permission: Record<string, string[]>) {
  const [existing] = await db
    .select()
    .from(schema.organizationRole)
    .where(and(eq(schema.organizationRole.organizationId, organizationId), eq(schema.organizationRole.role, role)));

  if (!existing) {
    await db.insert(schema.organizationRole).values({
      id: id("organizationRole"),
      organizationId,
      role,
      permission: JSON.stringify(permission),
      createdAt: new Date(),
    });
  }
}

async function ensureInvitation(organizationId: string, email: string, role: string, inviterId: string) {
  const [existing] = await db
    .select()
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.organizationId, organizationId),
        eq(schema.invitation.email, email),
        eq(schema.invitation.status, "pending"),
      ),
    );

  if (existing) return existing.id;
  const invitationId = id("invitation");

  await db.insert(schema.invitation).values({
    id: invitationId,
    organizationId,
    email,
    role,
    status: "pending",
    inviterId,
    expiresAt: new Date(Date.now() + INVITATION_TTL_SECONDS * 1000),
    createdAt: new Date(),
  });

  return invitationId;
}

await ensureUser("admin@demo.test", "Demo Admin", "admin");
const owner = await ensureUser("owner@demo.test", "Olivia Owner");
const analyst = await ensureUser("analyst@demo.test", "Adam Analyst");
const globexOwner = await ensureUser("globex@demo.test", "Gina Globex");

const acme = await ensureOrg("acme", "Acme", ["datahub", "ago"]);
const globex = await ensureOrg("globex", "Globex", ["datahub"]);

await ensureRole(acme, "analyst", { datahub: ["access", "import-read"] });
await ensureMember(acme, owner, "owner");
await ensureMember(acme, analyst, "analyst");
await ensureMember(globex, globexOwner, "owner");
await ensureMember(globex, analyst, "member");
const invitationId = await ensureInvitation(acme, "invitee@demo.test", "member", owner);

console.log(`
Demo data ready (password for every account: ${PASSWORD})

  admin@demo.test     global admin (local demo only — production admins sign in through Authentik)
  owner@demo.test     owner of Acme (Data hub + App)
  analyst@demo.test   "analyst" in Acme (Data hub access + import-read), member of Globex
  globex@demo.test    owner of Globex (Data hub)

Pending invitation: ${env.AUTH_BASE_URL}/invite/${invitationId}?email=invitee@demo.test
`);
await pool.end();

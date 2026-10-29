import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../server/lib/db/index";
import {
  agent,
  createOrganization,
  createUser,
  extractLink,
  PASSWORD,
  resetDb,
  setupOrgWithOwner,
  signIn,
  signedInAdmin,
  uniqueEmail,
  waitForEmail,
} from "./helpers/index";

describe("invitation-only sign-up", () => {
  beforeEach(resetDb);

  it("does not create a user on password sign-up without a pending invitation", async () => {
    const res = await agent()
      .post("/api/auth/sign-up/email")
      .send({ email: uniqueEmail(), password: PASSWORD, name: "Nobody" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeNull();
    expect(await db.select().from(schema.user)).toHaveLength(0);
  });

  it("does not create a user through a magic link without invitation", async () => {
    const email = uniqueEmail("magic");
    const a = agent();

    await a.post("/api/auth/sign-in/magic-link").send({ email, callbackURL: "/account" }).expect(200);
    const mail = await waitForEmail(email, { subject: /lien de connexion/ });
    const res = await a.get(extractLink(mail.text).path);

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(await db.select().from(schema.user).where(eq(schema.user.email, email))).toHaveLength(0);
  });

  it("rejects sign-up when the invitation expired", async () => {
    const { agent: adminAgent } = await signedInAdmin();
    const org = await createOrganization(adminAgent);

    await db
      .update(schema.invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.invitation.id, org.invitationId));
    await agent()
      .post("/api/auth/sign-up/email")
      .send({ email: org.ownerEmail, password: PASSWORD, name: "Late" })
      .expect(200);
    expect(await db.select().from(schema.user).where(eq(schema.user.email, org.ownerEmail))).toHaveLength(0);
  });
});

describe("organization creation", () => {
  beforeEach(resetDb);

  it("lets an admin create an organization and invite its owner without joining it", async () => {
    const { agent: adminAgent, admin } = await signedInAdmin();
    const org = await createOrganization(adminAgent, { apps: ["datahub"] });

    const [row] = await db.select().from(schema.organization).where(eq(schema.organization.id, org.organizationId));

    expect(row?.apps).toEqual(["datahub"]);
    expect(await db.select().from(schema.member).where(eq(schema.member.userId, admin.id))).toHaveLength(0);

    const [invitation] = await db.select().from(schema.invitation).where(eq(schema.invitation.id, org.invitationId));

    expect(invitation?.role).toBe("owner");
    const days = (invitation!.expiresAt.getTime() - Date.now()) / 86_400_000;

    expect(days).toBeGreaterThan(6.9);

    const mail = await waitForEmail(org.ownerEmail, { subject: /Invitation/ });
    const { url } = extractLink(mail.text);

    expect(url.pathname).toBe(`/invite/${org.invitationId}`);
    expect(url.searchParams.get("email")).toBe(org.ownerEmail);
  });

  it("forbids non-admins from creating organizations", async () => {
    const user = await createUser();
    const a = await signIn(user.email);

    await a
      .post("/api/admin/organizations")
      .send({ name: "X", slug: "x-org", apps: [], ownerEmail: uniqueEmail() })
      .expect(403);
    const res = await a.post("/api/auth/organization/create").send({ name: "X", slug: "x-org" });

    expect(res.status).toBe(403);
    await agent().post("/api/admin/organizations").send({}).expect(401);
  });

  it("validates admin input", async () => {
    const { agent: adminAgent } = await signedInAdmin();
    const res = await adminAgent
      .post("/api/admin/organizations")
      .send({ name: "X", slug: "Not A Slug", apps: ["unknown"], ownerEmail: "nope" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("does not let users change the apps ceiling", async () => {
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);
    const res = await owner
      .post("/api/auth/organization/update")
      .send({ organizationId, data: { apps: ["datahub", "ago"] } });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("APPS_CEILING_ADMIN_ONLY");
    const [row] = await db.select().from(schema.organization).where(eq(schema.organization.id, organizationId));

    expect(row?.apps).toEqual(["datahub"]);
  });

  it("lists organizations with their member count", async () => {
    const { adminAgent, organizationId } = await setupOrgWithOwner(["datahub"]);
    const res = await adminAgent.get("/api/admin/organizations").expect(200);
    const row = res.body.organizations.find((o: { id: string }) => o.id === organizationId);

    expect(row).toMatchObject({ apps: ["datahub"], memberCount: 1 });
  });

  it("lets an admin update the apps ceiling", async () => {
    const { adminAgent, organizationId } = await setupOrgWithOwner(["datahub"]);
    const res = await adminAgent.patch(`/api/admin/organizations/${organizationId}`).send({ apps: ["ago"] });

    expect(res.status).toBe(200);
    expect(res.body.organization.apps).toEqual(["ago"]);
  });
});

describe("invitation flow", () => {
  beforeEach(resetDb);

  it("turns the invited owner into a member with an active organization", async () => {
    const { owner, organizationId, ownerEmail } = await setupOrgWithOwner();
    const session = await owner.get("/api/auth/get-session").expect(200);

    expect(session.body.session.activeOrganizationId).toBe(organizationId);
    const [m] = await db
      .select()
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.user.email, ownerEmail));

    expect(m?.member.role).toBe("owner");
  });

  it("lets an owner invite a member who joins through a magic link", async () => {
    const { owner, organizationId } = await setupOrgWithOwner();
    const email = uniqueEmail("member");
    const invite = await owner
      .post("/api/auth/organization/invite-member")
      .send({ email, role: "member", organizationId });

    expect(invite.status).toBe(200);

    const inviteMail = await waitForEmail(email, { subject: /Invitation/ });
    const { url } = extractLink(inviteMail.text);
    const invitationId = url.pathname.split("/").pop()!;

    const a = agent();

    await a
      .post("/api/auth/sign-in/magic-link")
      .send({ email, callbackURL: url.pathname + url.search })
      .expect(200);
    const magic = await waitForEmail(email, { subject: /lien de connexion/ });
    const verify = await a.get(extractLink(magic.text).path);

    expect(verify.status).toBe(302);
    expect(verify.headers.location).toContain(`/invite/${invitationId}`);

    await a.post("/api/auth/organization/accept-invitation").send({ invitationId }).expect(200);
    const members = await db.select().from(schema.member).where(eq(schema.member.organizationId, organizationId));

    expect(members.map((m) => m.role).sort()).toEqual(["member", "owner"]);
  });

  it("lets an existing user accept an invitation after signing in", async () => {
    const { owner, organizationId } = await setupOrgWithOwner();
    const existing = await createUser();
    const inv = await owner
      .post("/api/auth/organization/invite-member")
      .send({ email: existing.email, role: "member", organizationId })
      .expect(200);
    const a = await signIn(existing.email);

    await a.post("/api/auth/organization/accept-invitation").send({ invitationId: inv.body.id }).expect(200);
  });

  it("refuses an invitation accepted by someone else", async () => {
    const { owner, organizationId } = await setupOrgWithOwner();
    const inv = await owner
      .post("/api/auth/organization/invite-member")
      .send({ email: uniqueEmail(), role: "member", organizationId })
      .expect(200);
    const intruder = await createUser();
    const a = await signIn(intruder.email);
    const res = await a.post("/api/auth/organization/accept-invitation").send({ invitationId: inv.body.id });

    expect(res.status).toBe(403);
  });
});

describe("dynamic roles", () => {
  beforeEach(resetDb);

  it("lets an owner create a custom role within the ceiling and assign it", async () => {
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);
    const res = await owner.post("/api/auth/organization/create-role").send({
      organizationId,
      role: "analyst",
      permission: { datahub: ["access", "import-read"] },
    });

    expect(res.status).toBe(200);

    const email = uniqueEmail("analyst");
    const inv = await owner
      .post("/api/auth/organization/invite-member")
      .send({ email, role: "analyst", organizationId });

    expect(inv.status).toBe(200);

    const roles = await db
      .select()
      .from(schema.organizationRole)
      .where(
        and(eq(schema.organizationRole.organizationId, organizationId), eq(schema.organizationRole.role, "analyst")),
      );

    expect(JSON.parse(roles[0]!.permission)).toEqual({ datahub: ["access", "import-read"] });
  });

  it("adds the mandatory access action when a role is saved without it", async () => {
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);
    const savedPermission = async () => {
      const [row] = await db
        .select()
        .from(schema.organizationRole)
        .where(
          and(eq(schema.organizationRole.organizationId, organizationId), eq(schema.organizationRole.role, "reader")),
        );

      return JSON.parse(row!.permission);
    };

    await owner
      .post("/api/auth/organization/create-role")
      .send({ organizationId, role: "reader", permission: { datahub: ["import-read"] } })
      .expect(200);
    expect(await savedPermission()).toEqual({ datahub: ["access", "import-read"] });

    await owner
      .post("/api/auth/organization/update-role")
      .send({ organizationId, roleName: "reader", data: { permission: { datahub: ["import"] } } })
      .expect(200);
    expect(await savedPermission()).toEqual({ datahub: ["access", "import"] });
  });

  it("drops actions that are not in the catalogue when a role is saved", async () => {
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);

    await owner
      .post("/api/auth/organization/create-role")
      .send({ organizationId, role: "legacy", permission: { datahub: ["access", "export", "import"] } })
      .expect(200);

    const [row] = await db
      .select()
      .from(schema.organizationRole)
      .where(
        and(eq(schema.organizationRole.organizationId, organizationId), eq(schema.organizationRole.role, "legacy")),
      );

    expect(JSON.parse(row!.permission)).toEqual({ datahub: ["access", "import"] });
  });

  it("rejects a role granting permissions outside the ceiling", async () => {
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);
    const create = await owner.post("/api/auth/organization/create-role").send({
      organizationId,
      role: "sneaky",
      permission: { ago: ["access"] },
    });

    expect(create.status).toBe(400);
    expect(create.body.code).toBe("PERMISSION_OUTSIDE_CEILING");

    await owner
      .post("/api/auth/organization/create-role")
      .send({ organizationId, role: "viewer", permission: { datahub: ["access"] } })
      .expect(200);
    const update = await owner.post("/api/auth/organization/update-role").send({
      organizationId,
      roleName: "viewer",
      data: { permission: { datahub: ["access"], ago: ["admin"] } },
    });

    expect(update.status).toBe(400);
    expect(update.body.code).toBe("PERMISSION_OUTSIDE_CEILING");
  });

  it("forbids plain members from creating roles", async () => {
    const { owner, organizationId } = await setupOrgWithOwner();
    const memberUser = await createUser();
    const inv = await owner
      .post("/api/auth/organization/invite-member")
      .send({ email: memberUser.email, role: "member", organizationId })
      .expect(200);
    const m = await signIn(memberUser.email);

    await m.post("/api/auth/organization/accept-invitation").send({ invitationId: inv.body.id }).expect(200);
    const res = await m
      .post("/api/auth/organization/create-role")
      .send({ organizationId, role: "hacker", permission: { datahub: ["access"] } });

    expect(res.status).toBe(403);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../server/lib/db/index";
import {
  acceptInvitationAsNewUser,
  agent,
  createUser,
  extractLink,
  resetDb,
  setupOrgWithOwner,
  signedInAdmin,
  signIn,
  uniqueEmail,
  waitForEmail,
  type Agent,
} from "./helpers";

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function addMember(owner: Agent, organizationId: string, role = "member") {
  const email = uniqueEmail("member");
  const inv = await owner
    .post("/api/auth/organization/invite-member")
    .send({ email, role, organizationId })
    .expect(200);
  const member = await acceptInvitationAsNewUser(email, inv.body.id);

  await member.post("/api/auth/organization/set-active").send({ organizationId }).expect(200);
  const [row] = await db
    .select({ id: schema.member.id, userId: schema.member.userId })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, organizationId), eq(schema.user.email, email)));

  return { agent: member, email, memberId: row!.id, userId: row!.userId };
}

const memberRole = async (memberId: string) =>
  (await db.select({ role: schema.member.role }).from(schema.member).where(eq(schema.member.id, memberId)))[0]?.role;

const auditActions = async (action: string) =>
  db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

const userExists = async (email: string) =>
  (await db.select().from(schema.user).where(eq(schema.user.email, email))).length > 0;

describe("admin invitations with any role", () => {
  beforeEach(resetDb);

  it("invites with a static or custom role and lists the organization roles", async () => {
    const { owner, adminAgent, organizationId } = await setupOrgWithOwner(["datahub"]);

    await owner
      .post("/api/auth/organization/create-role")
      .send({ organizationId, role: "analyst", permission: { datahub: ["access"] } })
      .expect(200);

    const detail = await adminAgent.get(`/api/admin/organizations/${organizationId}`).expect(200);

    expect(detail.body.roles).toEqual(["owner", "member", "analyst"]);

    const email = uniqueEmail("analyst");
    const res = await adminAgent
      .post(`/api/admin/organizations/${organizationId}/invitations`)
      .send({ email, role: "analyst" })
      .expect(201);

    await waitForEmail(email, { subject: /Invitation/ });
    await acceptInvitationAsNewUser(email, res.body.invitationId);
    const [member] = await db
      .select({ role: schema.member.role })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.user.email, email));

    expect(member?.role).toBe("analyst");

    const [entry] = (await auditActions("invitation.create")).filter((e) => e.targetId === res.body.invitationId);

    expect(entry?.metadata).toMatchObject({ email, role: "analyst" });
  });

  it("defaults to the owner role", async () => {
    const { adminAgent, organizationId } = await setupOrgWithOwner();
    const res = await adminAgent
      .post(`/api/admin/organizations/${organizationId}/invitations`)
      .send({ email: uniqueEmail() })
      .expect(201);
    const [invitation] = await db
      .select()
      .from(schema.invitation)
      .where(eq(schema.invitation.id, res.body.invitationId));

    expect(invitation?.role).toBe("owner");
  });

  it("refuses unknown roles, existing members and non-admins", async () => {
    const { owner, adminAgent, organizationId, ownerEmail } = await setupOrgWithOwner();
    const unknown = await adminAgent
      .post(`/api/admin/organizations/${organizationId}/invitations`)
      .send({ email: uniqueEmail(), role: "ghost" });

    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe("UNKNOWN_ROLE");

    const existing = await adminAgent
      .post(`/api/admin/organizations/${organizationId}/invitations`)
      .send({ email: ownerEmail, role: "member" });

    expect(existing.status).toBe(409);
    expect(existing.body.code).toBe("ALREADY_MEMBER");

    await adminAgent.post("/api/admin/organizations/unknown/invitations").send({ email: uniqueEmail() }).expect(404);
    await owner
      .post(`/api/admin/organizations/${organizationId}/invitations`)
      .send({ email: uniqueEmail() })
      .expect(403);
  });
});

describe("ownership transfer and leaving", () => {
  beforeEach(resetDb);

  it("lets an owner hand over the owner role and become a member", async () => {
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);

    await owner.post("/api/auth/organization/set-active").send({ organizationId }).expect(200);
    const member = await addMember(owner, organizationId);
    const [ownerRow] = await db
      .select()
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.role, "owner")));

    await owner.post("/api/account/organization/transfer-ownership").send({ memberId: member.memberId }).expect(200);
    expect(await memberRole(member.memberId)).toBe("owner");
    expect(await memberRole(ownerRow!.id)).toBe("member");

    const [entry] = await auditActions("organization.owner.transfer");

    expect(entry).toMatchObject({ organizationId, targetId: member.memberId });

    const again = await owner.post("/api/account/organization/transfer-ownership").send({ memberId: member.memberId });

    expect(again.status).toBe(403);
    expect(again.body.code).toBe("NOT_AN_OWNER");
    await owner.get("/api/account/organization/people").expect(403);
  });

  it("refuses transfers to oneself, to an owner or outside the organization", async () => {
    const { owner, organizationId } = await setupOrgWithOwner();

    await owner.post("/api/auth/organization/set-active").send({ organizationId }).expect(200);
    const [ownerRow] = await db.select().from(schema.member).where(eq(schema.member.organizationId, organizationId));
    const self = await owner.post("/api/account/organization/transfer-ownership").send({ memberId: ownerRow!.id });

    expect(self.body.code).toBe("MEMBER_NOT_FOUND");

    const coOwner = await addMember(owner, organizationId, "owner");
    const already = await owner
      .post("/api/account/organization/transfer-ownership")
      .send({ memberId: coOwner.memberId });

    expect(already.status).toBe(409);
    expect(already.body.code).toBe("ALREADY_OWNER");

    const other = await setupOrgWithOwner();
    const [otherOwner] = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.organizationId, other.organizationId));
    const outside = await owner.post("/api/account/organization/transfer-ownership").send({ memberId: otherOwner!.id });

    expect(outside.status).toBe(404);
  });

  it("lets members leave but keeps the last owner", async () => {
    const { owner, organizationId } = await setupOrgWithOwner();
    const member = await addMember(owner, organizationId);

    await member.agent.post("/api/auth/organization/leave").send({ organizationId }).expect(200);
    expect(await memberRole(member.memberId)).toBeUndefined();
    const [entry] = await auditActions("member.leave");

    expect(entry).toMatchObject({ organizationId, targetId: member.memberId, actorId: member.userId });

    const last = await owner.post("/api/auth/organization/leave").send({ organizationId });

    expect(last.status).toBe(400);
    expect(last.body.code).toBe("YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER");
  });
});

describe("account deletion", () => {
  beforeEach(resetDb);

  it("pseudonymizes an account only after the emailed confirmation, and archives it", async () => {
    const { owner, organizationId, ownerEmail } = await setupOrgWithOwner();
    const member = await addMember(owner, organizationId, "owner");
    const invitee = uniqueEmail("invitee");

    await member.agent
      .post("/api/auth/organization/invite-member")
      .send({ email: invitee, role: "member", organizationId })
      .expect(200);

    expect((await member.agent.get("/api/account/deletion").expect(200)).body.blocker).toBeNull();
    await member.agent.post("/api/auth/delete-user").send({}).expect(404);
    await member.agent.post("/api/account/deletion").expect(200);
    expect(await userExists(member.email)).toBe(true);

    const mail = await waitForEmail(member.email, { subject: /suppression/ });

    expect(mail.text).toContain("1 an");
    const link = extractLink(mail.text).url;

    expect(link.pathname).toBe("/account/delete");
    const token = link.searchParams.get("token")!;

    const wrong = await member.agent.post("/api/account/deletion/confirm").send({ token: "not-a-token" });

    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("INVALID_TOKEN");
    const ownerTry = await owner.post("/api/account/deletion/confirm").send({ token });

    expect(ownerTry.body.code).toBe("INVALID_TOKEN");
    expect(await userExists(member.email)).toBe(true);

    await member.agent.post("/api/account/deletion/confirm").send({ token }).expect(200);
    await member.agent.post("/api/account/deletion/confirm").send({ token }).expect(401);

    const [row] = await db.select().from(schema.user).where(eq(schema.user.id, member.userId));

    expect(row).toMatchObject({
      name: "Utilisateur supprimé",
      email: `deleted-${member.userId}@deleted.invalid`,
      banned: true,
    });
    expect(row!.deletedAt).toBeInstanceOf(Date);
    expect(await userExists(member.email)).toBe(false);
    expect(await memberRole(member.memberId)).toBeUndefined();
    expect(await db.select().from(schema.account).where(eq(schema.account.userId, member.userId))).toHaveLength(0);
    expect(await db.select().from(schema.session).where(eq(schema.session.userId, member.userId))).toHaveLength(0);
    expect((await member.agent.get("/api/auth/get-session")).body).toBeNull();
    expect(await db.select().from(schema.invitation).where(eq(schema.invitation.email, invitee))).toHaveLength(1);

    const [archive] = await db
      .select()
      .from(schema.deletedAccountArchive)
      .where(eq(schema.deletedAccountArchive.userId, member.userId));

    expect(archive).toMatchObject({ email: member.email, reason: "self" });
    expect((archive!.connections as { sessions: unknown[] }).sessions.length).toBeGreaterThan(0);
    const days = (archive!.expiresAt.getTime() - archive!.deletedAt.getTime()) / 86_400_000;

    expect(Math.round(days)).toBe(365);

    await waitForEmail(member.email, { subject: /a été supprimé/ });
    const [entry] = await auditActions("user.delete");

    expect(entry).toMatchObject({ targetId: member.userId, metadata: { by: "self" } });
    expect(ownerEmail).not.toBe(member.email);
  });

  it("refuses the only owner of an organization, staff accounts and impersonation", async () => {
    const { owner, adminAgent, ownerEmail } = await setupOrgWithOwner();
    const blocked = await owner.get("/api/account/deletion").expect(200);

    expect(blocked.body.blocker).toMatchObject({ code: "SOLE_OWNER" });
    const res = await owner.post("/api/account/deletion");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SOLE_OWNER");

    const staff = await adminAgent.post("/api/account/deletion");

    expect(staff.status).toBe(403);
    expect(staff.body.code).toBe("STAFF_ACCOUNT_MANAGED_IN_AUTHENTIK");

    const [ownerUser] = await db.select().from(schema.user).where(eq(schema.user.email, ownerEmail));

    await adminAgent.post("/api/auth/admin/impersonate-user").send({ userId: ownerUser!.id }).expect(200);
    await adminAgent.post("/api/account/deletion").expect(403);
  });

  it("lets admins delete accounts through the guarded route only", async () => {
    const { owner, adminAgent, admin, organizationId, ownerEmail } = await setupOrgWithOwner();
    const member = await addMember(owner, organizationId);

    await adminAgent.post("/api/auth/admin/remove-user").send({ userId: member.userId }).expect(404);
    await owner.delete(`/api/admin/users/${member.userId}`).expect(403);

    await adminAgent.delete(`/api/admin/users/${member.userId}`).expect(200);
    expect(await userExists(member.email)).toBe(false);
    const [row] = await db.select().from(schema.user).where(eq(schema.user.id, member.userId));

    expect(row?.deletedAt).toBeInstanceOf(Date);
    await waitForEmail(member.email, { subject: /a été supprimé/ });
    const [entry] = await auditActions("user.delete");

    expect(entry).toMatchObject({ actorId: admin.id, targetId: member.userId, metadata: { by: "admin" } });
    await adminAgent.delete(`/api/admin/users/${member.userId}`).expect(404);

    const archives = await adminAgent.get("/api/admin/archives").query({ email: member.email }).expect(200);

    expect(archives.body.archives).toEqual([expect.objectContaining({ email: member.email, reason: "admin" })]);
    await owner.get("/api/admin/archives").query({ email: member.email }).expect(403);
    await adminAgent.get("/api/admin/archives").query({ email: "ab" }).expect(400);
    const exported = await adminAgent.get(`/api/admin/archives/${archives.body.archives[0].id}/export`).expect(200);

    expect(exported.headers["content-disposition"]).toContain("attachment");
    expect(JSON.parse(exported.text)).toMatchObject({ userId: member.userId, email: member.email });
    const [consulted] = await auditActions("archive.export");

    expect(consulted).toMatchObject({ actorId: admin.id, targetId: member.userId });

    const [ownerUser] = await db.select().from(schema.user).where(eq(schema.user.email, ownerEmail));
    const sole = await adminAgent.delete(`/api/admin/users/${ownerUser!.id}`);

    expect(sole.status).toBe(409);
    expect(sole.body.code).toBe("SOLE_OWNER");

    const otherAdmin = await createUser({ role: "admin" });
    const staff = await adminAgent.delete(`/api/admin/users/${otherAdmin.id}`);

    expect(staff.status).toBe(403);
    await adminAgent.delete(`/api/admin/users/${admin.id}`).expect(400);
    await adminAgent.delete("/api/admin/users/unknown").expect(404);
  });
});

describe("organization deletion", () => {
  beforeEach(resetDb);

  it("requires the slug and removes members, invitations and active selections", async () => {
    const { owner, adminAgent, organizationId } = await setupOrgWithOwner();

    await owner.post("/api/auth/organization/set-active").send({ organizationId }).expect(200);
    await owner
      .post("/api/auth/organization/invite-member")
      .send({ email: uniqueEmail(), role: "member", organizationId })
      .expect(200);
    const [org] = await db.select().from(schema.organization).where(eq(schema.organization.id, organizationId));

    await owner.delete(`/api/admin/organizations/${organizationId}`).send({ confirm: org!.slug }).expect(403);
    const mismatch = await adminAgent.delete(`/api/admin/organizations/${organizationId}`).send({ confirm: "nope" });

    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe("CONFIRMATION_MISMATCH");

    await adminAgent.delete(`/api/admin/organizations/${organizationId}`).send({ confirm: org!.slug }).expect(200);
    expect(await db.select().from(schema.organization).where(eq(schema.organization.id, organizationId))).toHaveLength(
      0,
    );
    expect(await db.select().from(schema.member).where(eq(schema.member.organizationId, organizationId))).toHaveLength(
      0,
    );
    expect(
      await db.select().from(schema.invitation).where(eq(schema.invitation.organizationId, organizationId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.session).where(eq(schema.session.activeOrganizationId, organizationId)),
    ).toHaveLength(0);

    const [entry] = await auditActions("organization.delete");

    expect(entry).toMatchObject({ organizationId, metadata: { slug: org!.slug, members: 1 } });
    await owner.get("/api/account/organization").expect(401);
    await adminAgent.delete(`/api/admin/organizations/${organizationId}`).send({ confirm: org!.slug }).expect(404);
  });
});

describe("organization name and logo", () => {
  beforeEach(resetDb);

  const update = (a: Agent, organizationId: string, data: Record<string, unknown>) =>
    a.post("/api/auth/organization/update").send({ organizationId, data });

  it("lets managers rename the organization and upload a logo served with caching", async () => {
    const { owner, organizationId } = await setupOrgWithOwner();

    await owner.post("/api/auth/organization/set-active").send({ organizationId }).expect(200);

    await update(owner, organizationId, { name: "  Acme Renamed  " }).expect(200);
    await update(owner, organizationId, { logo: `data:image/png;base64,${PIXEL}` }).expect(200);

    const insights = await owner.get("/api/account/organization").expect(200);

    expect(insights.body.organization.name).toBe("Acme Renamed");
    const logoUrl = insights.body.organization.logoUrl as string;

    expect(logoUrl).toMatch(new RegExp(`^/api/public/organizations/${organizationId}/logo\\?v=[0-9a-f]{12}$`));

    const context = await owner.get("/api/account/context").expect(200);

    expect(context.body.organizations[0].logoUrl).toBe(logoUrl);

    const image = await agent().get(logoUrl).buffer(true).expect(200);

    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["cache-control"]).toContain("immutable");
    expect(Buffer.compare(image.body as Buffer, Buffer.from(PIXEL, "base64"))).toBe(0);

    const entries = await auditActions("organization.update");

    expect(entries.map((e) => (e.metadata as { changes?: { logo?: string } }).changes?.logo)).toContain("updated");
    expect(JSON.stringify(entries)).not.toContain(PIXEL);

    await update(owner, organizationId, { logo: "" }).expect(200);
    expect((await owner.get("/api/account/organization").expect(200)).body.organization.logoUrl).toBeNull();
    await agent().get(`/api/public/organizations/${organizationId}/logo`).expect(404);
  });

  it("validates the name and the logo and keeps other fields for admins", async () => {
    const { owner, organizationId } = await setupOrgWithOwner();
    const svg = await update(owner, organizationId, { logo: "data:image/svg+xml;base64,PHN2Zy8+" });

    expect(svg.body.code).toBe("INVALID_LOGO");
    const script = await update(owner, organizationId, { logo: "javascript:alert(1)" });

    expect(script.body.code).toBe("INVALID_LOGO");
    const huge = await update(owner, organizationId, { logo: `data:image/png;base64,${"A".repeat(200_000)}` });

    expect(huge.body.code).toBe("LOGO_TOO_LARGE");
    const blank = await update(owner, organizationId, { name: "   " });

    expect(blank.body.code).toBe("INVALID_ORGANIZATION_NAME");
    const slug = await update(owner, organizationId, { slug: "hijacked" });

    expect(slug.status).toBe(403);
    expect(slug.body.code).toBe("ORGANIZATION_FIELD_ADMIN_ONLY");

    const member = await addMember(owner, organizationId);

    await update(member.agent, organizationId, { name: "Not allowed" }).expect(403);
  });

  it("shows logos in the admin list", async () => {
    const { owner, adminAgent, organizationId } = await setupOrgWithOwner();

    await update(owner, organizationId, { logo: `data:image/png;base64,${PIXEL}` }).expect(200);
    const list = await adminAgent.get("/api/admin/organizations").expect(200);

    expect(list.body.organizations[0].logoUrl).toMatch(/\/logo\?v=/);
    expect(JSON.stringify(list.body)).not.toContain(PIXEL);
    const detail = await adminAgent.get(`/api/admin/organizations/${organizationId}`).expect(200);

    expect(detail.body.organization).not.toHaveProperty("logo");
  });
});

describe("guards", () => {
  beforeEach(resetDb);

  it("keeps deletion endpoints private", async () => {
    await agent().get("/api/account/deletion").expect(401);
    const user = await createUser();
    const a = await signIn(user.email);

    await a.post("/api/account/organization/transfer-ownership").send({ memberId: "x" }).expect(400);
    const { agent: adminAgent } = await signedInAdmin();

    await adminAgent.get("/api/admin/organizations/unknown").expect(404);
  });
});

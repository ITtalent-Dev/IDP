import { beforeEach, describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../server/lib/db/index";
import { ACCESS_CLAIM, IMPERSONATED_BY_CLAIM } from "../server/lib/auth/access-claims";
import {
  agent,
  createUser,
  resetDb,
  setupOrgWithOwner,
  signIn,
  signedInAdmin,
  uniqueEmail,
  type Agent,
} from "./helpers/index";
import { fakeCode, type FakeProfile } from "./helpers/fake-idp";
import { exchangeCode, authorize, getAccessToken, seedTestClients } from "./helpers/oauth";

async function socialCallback(a: Agent, start: { body: { url: string } }, profile: Omit<FakeProfile, "nonce">) {
  const authUrl = new URL(start.body.url);
  const redirect = new URL(authUrl.searchParams.get("redirect_uri")!);
  const code = fakeCode({ ...profile, nonce: authUrl.searchParams.get("nonce") ?? undefined });

  return a.get(`${redirect.pathname}?code=${code}&state=${authUrl.searchParams.get("state")}`);
}

async function signInWithAuthentik(profile: Omit<FakeProfile, "nonce">) {
  const a = agent();
  const start = await a.post("/api/auth/sign-in/social").send({ provider: "authentik", callbackURL: "/admin" });

  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const cb = await socialCallback(a, start, profile);

  return { agent: a, callback: cb };
}

async function signInWithGoogle(a: Agent, profile: Omit<FakeProfile, "nonce">) {
  const start = await a.post("/api/auth/sign-in/social").send({ provider: "google", callbackURL: "/account" });

  expect(start.status, JSON.stringify(start.body)).toBe(200);

  return socialCallback(a, start, profile);
}

const auditRows = (action: string) => db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

describe("admins through Authentik", () => {
  beforeEach(resetDb);

  it("creates an admin account on first Authentik sign-in without invitation", async () => {
    const email = uniqueEmail("staff");
    const { agent: a, callback } = await signInWithAuthentik({ sub: "ak-1", email, name: "Staff" });

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain("/admin");
    const session = await a.get("/api/auth/get-session").expect(200);

    expect(session.body.user.email).toBe(email);
    expect(session.body.user.role).toBe("admin");
    await a.get("/api/admin/organizations").expect(200);
  });

  it("keeps regular users out of admin endpoints", async () => {
    const user = await createUser();
    const a = await signIn(user.email);

    await a.get("/api/admin/organizations").expect(403);
    await a.get("/api/admin/audit").expect(403);
    const res = await a.post("/api/auth/admin/list-users").send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("Google sign-in and account linking", () => {
  beforeEach(resetDb);

  it("refuses a new Google user without invitation", async () => {
    const email = uniqueEmail("google");
    const cb = await signInWithGoogle(agent(), { sub: "g-1", email });

    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain("error");
    expect(await db.select().from(schema.user).where(eq(schema.user.email, email))).toHaveLength(0);
  });

  it("accepts a new Google user holding an invitation", async () => {
    const { owner, organizationId } = await setupOrgWithOwner();
    const email = uniqueEmail("google");

    await owner
      .post("/api/auth/organization/invite-member")
      .send({ email, role: "member", organizationId })
      .expect(200);
    const a = agent();
    const cb = await signInWithGoogle(a, { sub: "g-2", email });

    expect(cb.headers.location).not.toContain("error");
    expect((await a.get("/api/auth/get-session").expect(200)).body.user.email).toBe(email);
  });

  it("links Google automatically to an existing account with the same email, then unlinks it", async () => {
    const user = await createUser();
    const a = agent();
    const cb = await signInWithGoogle(a, { sub: "g-3", email: user.email });

    expect(cb.headers.location).not.toContain("error");
    const accounts = await a.get("/api/auth/list-accounts").expect(200);

    expect(accounts.body.map((x: { providerId: string }) => x.providerId).sort()).toEqual(["credential", "google"]);

    const google = accounts.body.find((x: { providerId: string }) => x.providerId === "google");
    const unlink = await a.post("/api/auth/unlink-account").send({ accountId: google.id });

    expect(unlink.status, JSON.stringify(unlink.body)).toBe(200);
    const after = await a.get("/api/auth/list-accounts").expect(200);

    expect(after.body.map((x: { providerId: string }) => x.providerId)).toEqual(["credential"]);
  });

  it("lets a signed-in user link Google explicitly", async () => {
    const user = await createUser();
    const a = await signIn(user.email);
    const start = await a.post("/api/auth/link-social").send({ provider: "google", callbackURL: "/account" });

    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const cb = await socialCallback(a, start, { sub: "g-4", email: user.email });

    expect(cb.headers.location).not.toContain("error");
    const [linked] = await db
      .select()
      .from(schema.account)
      .where(and(eq(schema.account.userId, user.id), eq(schema.account.providerId, "google")));

    expect(linked?.accountId).toBe("g-4");
  });
});

describe("impersonation", () => {
  beforeEach(resetDb);

  it("tags tokens with impersonated_by and never issues refresh tokens", async () => {
    const clients = await seedTestClients();
    const { admin, agent: adminAgent } = await signedInAdmin();
    const org = await setupOrgWithOwner(["datahub"]);
    const [owner] = await db.select().from(schema.user).where(eq(schema.user.email, org.ownerEmail));

    const imp = await adminAgent.post("/api/auth/admin/impersonate-user").send({ userId: owner!.id });

    expect(imp.status, JSON.stringify(imp.body)).toBe(200);
    const session = await adminAgent.get("/api/auth/get-session").expect(200);

    expect(session.body.user.id).toBe(owner!.id);
    expect(session.body.session.impersonatedBy).toBe(admin.id);
    const ttl = (new Date(session.body.session.expiresAt).getTime() - Date.now()) / 1000;

    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);

    const token = await getAccessToken(adminAgent, clients.datahub);

    expect(token.status, JSON.stringify(token.body)).toBe(200);
    expect(token.body.refresh_token).toBeUndefined();
    const payload = decodeJwt(token.body.access_token);

    expect(payload[IMPERSONATED_BY_CLAIM]).toBe(admin.id);
    expect(payload[ACCESS_CLAIM]).toEqual({
      [org.organizationId]: ["access", "import", "import-read"],
    });
    expect(payload.sub).toBe(owner!.id);

    await adminAgent.post("/api/auth/admin/stop-impersonating").send({}).expect(200);
    expect((await adminAgent.get("/api/auth/get-session").expect(200)).body.user.id).toBe(admin.id);

    const [start] = await auditRows("impersonation.start");

    expect(start).toMatchObject({ actorId: admin.id, targetId: owner!.id });
    const [stop] = await auditRows("impersonation.stop");

    expect(stop).toMatchObject({ actorId: admin.id, targetId: owner!.id });
  });

  it("is reserved to admins", async () => {
    const { owner } = await setupOrgWithOwner();
    const victim = await createUser();
    const res = await owner.post("/api/auth/admin/impersonate-user").send({ userId: victim.id });

    expect(res.status).toBeGreaterThanOrEqual(401);
  });
});

describe("audit log", () => {
  beforeEach(resetDb);

  it("records organization, role, invitation, member and ban events", async () => {
    const { owner, organizationId, adminAgent, admin } = await setupOrgWithOwner(["datahub"]);

    await adminAgent
      .patch(`/api/admin/organizations/${organizationId}`)
      .send({ apps: ["datahub", "ago"] })
      .expect(200);

    await owner
      .post("/api/auth/organization/create-role")
      .send({ organizationId, role: "analyst", permission: { datahub: ["access"] } })
      .expect(200);
    await owner
      .post("/api/auth/organization/update-role")
      .send({ organizationId, roleName: "analyst", data: { permission: { datahub: ["access", "import-read"] } } })
      .expect(200);

    const member = await createUser();
    const inv = await owner
      .post("/api/auth/organization/invite-member")
      .send({ email: member.email, role: "member", organizationId })
      .expect(200);
    const m = await signIn(member.email);
    const accepted = await m
      .post("/api/auth/organization/accept-invitation")
      .send({ invitationId: inv.body.id })
      .expect(200);
    const memberId = accepted.body.member.id as string;

    await owner
      .post("/api/auth/organization/update-member-role")
      .send({ organizationId, memberId, role: "analyst" })
      .expect(200);
    await owner
      .post("/api/auth/organization/remove-member")
      .send({ organizationId, memberIdOrEmail: memberId })
      .expect(200);
    await owner.post("/api/auth/organization/delete-role").send({ organizationId, roleName: "analyst" }).expect(200);
    await adminAgent.post("/api/auth/admin/ban-user").send({ userId: member.id, banReason: "abuse" }).expect(200);

    const res = await adminAgent.get("/api/admin/audit?limit=100").expect(200);
    const actions = res.body.entries.map((e: { action: string }) => e.action);

    for (const action of [
      "organization.create",
      "organization.ceiling.update",
      "role.create",
      "role.update",
      "role.delete",
      "invitation.create",
      "member.role.update",
      "member.remove",
      "user.ban",
    ]) {
      expect(actions, action).toContain(action);
    }

    const ban = res.body.entries.find((e: { action: string }) => e.action === "user.ban");

    expect(ban).toMatchObject({ actorId: admin.id, targetId: member.id, metadata: { reason: "abuse" } });

    const filtered = await adminAgent
      .get(`/api/admin/audit?action=role.create&organizationId=${organizationId}`)
      .expect(200);

    expect(filtered.body.entries).toHaveLength(1);
    expect(filtered.body.entries[0].metadata.permission).toEqual({ datahub: ["access"] });
  });

  it("does not record failed operations", async () => {
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);

    await owner
      .post("/api/auth/organization/create-role")
      .send({ organizationId, role: "bad", permission: { ago: ["access"] } })
      .expect(400);
    expect(await auditRows("role.create")).toHaveLength(0);
  });

  it("revokes banned users' access to tokens", async () => {
    const clients = await seedTestClients();
    const { owner, adminAgent } = await setupOrgWithOwner(["datahub"]);
    const me = await owner.get("/api/auth/get-session").expect(200);
    const auth = await authorize(owner, clients.datahub);

    await adminAgent.post("/api/auth/admin/ban-user").send({ userId: me.body.user.id }).expect(200);
    const res = await exchangeCode(clients.datahub, {
      code: auth.code!,
      verifier: auth.verifier,
      redirectUri: auth.redirectUri,
    });

    expect(res.body.access_token).toBeUndefined();
  });
});

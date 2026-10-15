import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { decodeJwt } from "jose";
import { db, schema } from "../server/lib/db/index";
import { ACCESS_CLAIM } from "../server/lib/auth/access-claims";
import { pseudonymizeUser } from "../server/lib/account-lifecycle";
import {
  agent,
  createUser,
  extractLink,
  resetDb,
  setupOrgWithOwner,
  signIn,
  waitForEmail,
  type Agent,
} from "./helpers/index";
import { getAccessToken, seedTestClients } from "./helpers/oauth";

const DATAHUB = process.env.DATAHUB_RESOURCE!;
const NEW_PASSWORD = "another-strong-password";

type Clients = Awaited<ReturnType<typeof seedTestClients>>;

function refresh(clients: Clients, refreshToken: string) {
  return agent()
    .post("/api/auth/oauth2/token")
    .auth(clients.datahub.clientId, clients.datahub.clientSecret)
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: refreshToken, resource: DATAHUB });
}

async function userIdOf(email: string) {
  const [row] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));

  return row!.id;
}

async function issueRefreshToken(clients: Clients, user: Agent): Promise<string> {
  const res = await getAccessToken(user, clients.datahub);

  expect(res.status, JSON.stringify(res.body)).toBe(200);

  return res.body.refresh_token as string;
}

async function expectRevoked(clients: Clients, refreshToken: string) {
  const res = await refresh(clients, refreshToken);

  expect(res.status).toBe(400);
  expect(res.body.error).toBe("invalid_grant");
}

async function actions() {
  return (await db.select({ action: schema.auditLog.action }).from(schema.auditLog)).map((r) => r.action);
}

describe("refresh token revocation", () => {
  beforeEach(resetDb);

  it("rejects a revoked refresh token with invalid_grant", async () => {
    const clients = await seedTestClients();
    const { owner, ownerEmail } = await setupOrgWithOwner(["datahub"]);
    const token = await issueRefreshToken(clients, owner);
    const userId = await userIdOf(ownerEmail);

    await db
      .update(schema.oauthRefreshToken)
      .set({ revoked: new Date() })
      .where(eq(schema.oauthRefreshToken.userId, userId));
    await expectRevoked(clients, token);
  });

  it("recomputes the access claim from the current permissions on refresh", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);

    await owner
      .post("/api/auth/organization/create-role")
      .send({ organizationId, role: "analyst", permission: { datahub: ["access", "import"] } })
      .expect(200);
    const user = await createUser();
    const inv = await owner
      .post("/api/auth/organization/invite-member")
      .send({ email: user.email, role: "analyst", organizationId })
      .expect(200);
    const member = await signIn(user.email);

    await member.post("/api/auth/organization/accept-invitation").send({ invitationId: inv.body.id }).expect(200);
    const first = await getAccessToken(member, clients.datahub);

    expect(decodeJwt(first.body.access_token)[ACCESS_CLAIM]).toEqual({ [organizationId]: ["access", "import"] });

    await owner
      .post("/api/auth/organization/update-role")
      .send({ organizationId, roleName: "analyst", data: { permission: { datahub: ["access"] } } })
      .expect(200);
    const narrowed = await refresh(clients, first.body.refresh_token);

    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    expect(decodeJwt(narrowed.body.access_token)[ACCESS_CLAIM]).toEqual({ [organizationId]: ["access"] });

    const [row] = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.userId, user.id));

    await owner
      .post("/api/auth/organization/remove-member")
      .send({ organizationId, memberIdOrEmail: row!.id })
      .expect(200);
    const removed = await refresh(clients, narrowed.body.refresh_token);

    if (removed.status === 200) expect(decodeJwt(removed.body.access_token)[ACCESS_CLAIM]).toBeUndefined();
    else expect(removed.status).toBeGreaterThanOrEqual(400);
  });

  it("revokes the refresh tokens of the signed-out session on a plain sign-out", async () => {
    const clients = await seedTestClients();
    const { owner, ownerEmail } = await setupOrgWithOwner(["datahub"]);
    const other = await signIn(ownerEmail);
    const token = await issueRefreshToken(clients, owner);
    const kept = await issueRefreshToken(clients, other);

    await owner.post("/api/auth/sign-out").send({}).expect(200);
    expect((await refresh(clients, kept)).status).toBe(200);
    await expectRevoked(clients, token);
    expect(await actions()).toContain("user.tokens.revoke");
  });

  it("revokes when an admin bans the account", async () => {
    const clients = await seedTestClients();
    const { owner, ownerEmail, adminAgent } = await setupOrgWithOwner(["datahub"]);
    const token = await issueRefreshToken(clients, owner);
    const userId = await userIdOf(ownerEmail);

    await adminAgent.post("/api/auth/admin/ban-user").send({ userId, banReason: "abuse" }).expect(200);
    await expectRevoked(clients, token);
    expect(await actions()).toContain("user.tokens.revoke");
  });

  it("revokes when an admin ends all the sessions of a user", async () => {
    const clients = await seedTestClients();
    const { owner, ownerEmail, adminAgent } = await setupOrgWithOwner(["datahub"]);
    const token = await issueRefreshToken(clients, owner);

    await adminAgent
      .post("/api/auth/admin/revoke-user-sessions")
      .send({ userId: await userIdOf(ownerEmail) })
      .expect(200);
    await expectRevoked(clients, token);
  });

  it("revokes when an admin sets a new password", async () => {
    const clients = await seedTestClients();
    const { owner, ownerEmail, adminAgent } = await setupOrgWithOwner(["datahub"]);
    const token = await issueRefreshToken(clients, owner);

    await adminAgent
      .post("/api/auth/admin/set-user-password")
      .send({ userId: await userIdOf(ownerEmail), newPassword: NEW_PASSWORD })
      .expect(200);
    await expectRevoked(clients, token);
  });

  it("revokes on password reset", async () => {
    const clients = await seedTestClients();
    const { owner, ownerEmail } = await setupOrgWithOwner(["datahub"]);
    const token = await issueRefreshToken(clients, owner);
    const a = agent();

    await a
      .post("/api/auth/request-password-reset")
      .send({ email: ownerEmail, redirectTo: "/reset-password" })
      .expect(200);
    const mail = await waitForEmail(ownerEmail, { subject: /Réinitialisation/ });
    const link = await a.get(extractLink(mail.text).path);
    const resetToken = new URL(link.headers.location ?? "", "http://x").searchParams.get("token");

    await a.post("/api/auth/reset-password").send({ token: resetToken, newPassword: NEW_PASSWORD }).expect(200);
    await expectRevoked(clients, token);
  });

  it("revokes every token on sign out everywhere", async () => {
    const clients = await seedTestClients();
    const { owner, ownerEmail } = await setupOrgWithOwner(["datahub"]);
    const first = await issueRefreshToken(clients, owner);
    const second = await issueRefreshToken(clients, await signIn(ownerEmail));

    await owner.post("/api/auth/revoke-sessions").send({}).expect(200);

    await expectRevoked(clients, first);
    await expectRevoked(clients, second);
    const live = await db
      .select()
      .from(schema.oauthRefreshToken)
      .where(
        and(eq(schema.oauthRefreshToken.userId, await userIdOf(ownerEmail)), isNull(schema.oauthRefreshToken.revoked)),
      );

    expect(live).toHaveLength(0);
  });

  it("keeps the current session's tokens on revoke-other-sessions", async () => {
    const clients = await seedTestClients();
    const { owner, ownerEmail } = await setupOrgWithOwner(["datahub"]);
    const current = await issueRefreshToken(clients, owner);
    const elsewhere = await issueRefreshToken(clients, await signIn(ownerEmail));

    await owner.post("/api/auth/revoke-other-sessions").send({}).expect(200);

    expect((await refresh(clients, current)).status).toBe(200);
    await expectRevoked(clients, elsewhere);
  });

  it("revokes only the tokens of that session on revoke-session", async () => {
    const clients = await seedTestClients();
    const { owner, ownerEmail } = await setupOrgWithOwner(["datahub"]);
    const current = await issueRefreshToken(clients, owner);
    const other = await signIn(ownerEmail);
    const elsewhere = await issueRefreshToken(clients, other);
    const otherToken = (await other.get("/api/auth/get-session").expect(200)).body.session.token as string;

    await owner.post("/api/auth/revoke-session").send({ token: otherToken }).expect(200);

    expect((await refresh(clients, current)).status).toBe(200);
    await expectRevoked(clients, elsewhere);
  });

  it("deletes the refresh tokens of a deleted account", async () => {
    const clients = await seedTestClients();
    const { owner, ownerEmail } = await setupOrgWithOwner(["datahub"]);
    const token = await issueRefreshToken(clients, owner);
    const userId = await userIdOf(ownerEmail);

    expect(await pseudonymizeUser(userId, "admin", { actorId: null })).toBe(true);

    expect((await refresh(clients, token)).status).toBeGreaterThanOrEqual(400);
    const rows = await db.select().from(schema.oauthRefreshToken).where(eq(schema.oauthRefreshToken.userId, userId));

    expect(rows).toHaveLength(0);
  });
});

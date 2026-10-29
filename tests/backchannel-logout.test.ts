import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { db, schema } from "../server/lib/db/index";
import {
  acceptInvitationAsNewUser,
  agent,
  extractLink,
  PASSWORD,
  resetDb,
  setupOrgWithOwner,
  uniqueEmail,
  waitForEmail,
  type Agent,
} from "./helpers/index";
import { runRetentionOnce } from "../server/lib/account-lifecycle";
import { ISSUER, getAccessToken, seedTestClients } from "./helpers/oauth";

const EVENT = "http://schemas.openid.net/event/backchannel-logout";
const RP_PORT = 4901;

type Clients = Awaited<ReturnType<typeof seedTestClients>>;

let server: Server;
let received: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";

    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/auth/backchannel-logout" && req.method === "POST") {
        const token = new URLSearchParams(body).get("logout_token");

        if (token) received.push(token);
      }

      res.writeHead(200, { "Cache-Control": "no-store" }).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(RP_PORT, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function waitForTokens(count: number) {
  const deadline = Date.now() + 5000;

  while (received.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

  expect(received.length).toBe(count);

  return received;
}

async function signedInWithTokens(clients: Clients, user: Agent) {
  const res = await getAccessToken(user, clients.datahub);

  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const sid = decodeJwt(res.body.id_token as string).sid;

  expect(typeof sid).toBe("string");

  return { sid: sid as string, sub: decodeJwt(res.body.id_token as string).sub as string };
}

async function expectLogoutToken(token: string, clients: Clients, expected: { sid: string; sub: string }) {
  const jwks = (await agent().get("/api/auth/jwks").expect(200)).body;
  const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), {
    issuer: ISSUER,
    audience: clients.datahub.clientId,
    typ: "logout+jwt",
  });

  expect(protectedHeader.alg).not.toBe("none");
  expect(decodeProtectedHeader(token).kid).toBeDefined();
  expect(payload.sid).toBe(expected.sid);
  expect(payload.sub).toBe(expected.sub);
  expect(payload.events).toEqual({ [EVENT]: {} });
  expect(typeof payload.jti).toBe("string");
  expect(typeof payload.iat).toBe("number");
  expect(payload).not.toHaveProperty("nonce");
}

async function userIdOf(email: string) {
  const [row] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));

  return row!.id;
}

describe("back-channel logout", () => {
  beforeEach(async () => {
    await resetDb();
    received = [];
  });

  it("registers the configured back-channel logout URI on the seeded client, also when re-seeding", async () => {
    await seedTestClients();
    const clients = await seedTestClients();
    const [row] = await db
      .select()
      .from(schema.oauthClient)
      .where(eq(schema.oauthClient.clientId, clients.datahub.clientId));

    expect(row!.backchannelLogoutUri).toBe(`http://127.0.0.1:${RP_PORT}/auth/backchannel-logout`);
    expect(row!.backchannelLogoutSessionRequired).toBe(true);
    const [app] = await db
      .select()
      .from(schema.oauthClient)
      .where(eq(schema.oauthClient.clientId, clients.ago.clientId));

    expect(app!.backchannelLogoutUri).toBeNull();
  });

  it("advertises back-channel logout in the discovery document", async () => {
    const res = await agent().get("/api/auth/.well-known/openid-configuration").expect(200);

    expect(res.body.backchannel_logout_supported).toBe(true);
    expect(res.body.backchannel_logout_session_supported).toBe(true);
  });

  it("sends a logout token on sign-out", async () => {
    const clients = await seedTestClients();
    const { owner } = await setupOrgWithOwner(["datahub"]);
    const expected = await signedInWithTokens(clients, owner);

    await owner.post("/api/auth/sign-out").send({}).expect(200);
    const [token] = await waitForTokens(1);

    await expectLogoutToken(token!, clients, expected);
  });

  it("sends a logout token for the previous account on an account switch", async () => {
    const clients = await seedTestClients();
    const a = await setupOrgWithOwner(["datahub"]);
    const b = await setupOrgWithOwner(["datahub"]);
    const user = a.owner;
    const expected = await signedInWithTokens(clients, user);

    await user.post("/api/auth/sign-out").send({}).expect(200);
    await user.post("/api/auth/sign-in/email").send({ email: b.ownerEmail, password: PASSWORD }).expect(200);
    const [token] = await waitForTokens(1);

    await expectLogoutToken(token!, clients, expected);
  });

  it("sends a logout token when the user revokes all their sessions", async () => {
    const clients = await seedTestClients();
    const { owner } = await setupOrgWithOwner(["datahub"]);
    const expected = await signedInWithTokens(clients, owner);

    await owner.post("/api/auth/revoke-sessions").send({}).expect(200);
    const [token] = await waitForTokens(1);

    await expectLogoutToken(token!, clients, expected);
  });

  it("sends a logout token when an admin bans the account", async () => {
    const clients = await seedTestClients();
    const { owner, ownerEmail, adminAgent } = await setupOrgWithOwner(["datahub"]);
    const expected = await signedInWithTokens(clients, owner);

    await adminAgent
      .post("/api/auth/admin/ban-user")
      .send({ userId: await userIdOf(ownerEmail), banReason: "abuse" })
      .expect(200);
    const [token] = await waitForTokens(1);

    await expectLogoutToken(token!, clients, expected);
  });

  it("sends a logout token and revokes the refresh token when support resets the second factor", async () => {
    const clients = await seedTestClients();
    const { owner, ownerEmail, adminAgent } = await setupOrgWithOwner(["datahub"]);
    const userId = await userIdOf(ownerEmail);
    const tokens = await getAccessToken(owner, clients.datahub);
    const expected = { sid: decodeJwt(tokens.body.id_token as string).sid as string, sub: userId };

    await db.update(schema.user).set({ twoFactorEnabled: true, hasPasskey: true }).where(eq(schema.user.id, userId));
    await db.insert(schema.passkey).values({
      id: "pk-reset",
      userId,
      publicKey: "key",
      credentialID: "cred-reset",
      counter: 0,
      deviceType: "multiDevice",
      backedUp: true,
    });

    await adminAgent.post(`/api/admin/users/${userId}/two-factor/reset`).expect(200);
    const [token] = await waitForTokens(1);

    await expectLogoutToken(token!, clients, expected);

    const refresh = await agent()
      .post("/api/auth/oauth2/token")
      .auth(clients.datahub.clientId, clients.datahub.clientSecret)
      .type("form")
      .send({
        grant_type: "refresh_token",
        refresh_token: tokens.body.refresh_token,
        resource: process.env.DATAHUB_RESOURCE,
      });

    expect(refresh.status).toBe(400);
    expect(refresh.body.error).toBe("invalid_grant");
    expect(await db.select().from(schema.session).where(eq(schema.session.userId, userId))).toHaveLength(0);
    expect((await adminAgent.get("/api/auth/get-session").expect(200)).body.user).toBeTruthy();
    expect(await db.select().from(schema.passkey).where(eq(schema.passkey.userId, userId))).toHaveLength(0);

    const audits = await db.select({ action: schema.auditLog.action }).from(schema.auditLog);
    const actions = audits.map((row) => row.action);

    expect(actions).toContain("user.two_factor.reset");
    expect(actions).toContain("user.tokens.revoke");
  });

  it("sends nothing for a session that never obtained tokens for the client", async () => {
    await seedTestClients();
    const { owner } = await setupOrgWithOwner(["datahub"]);

    await owner.post("/api/auth/sign-out").send({}).expect(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(0);
  });
});

async function addMemberWithTokens(clients: Clients, owner: Agent, organizationId: string) {
  const email = uniqueEmail("member");
  const invitation = await owner
    .post("/api/auth/organization/invite-member")
    .send({ email, role: "owner", organizationId })
    .expect(200);
  const member = await acceptInvitationAsNewUser(email, invitation.body.id);

  await member.post("/api/auth/organization/set-active").send({ organizationId }).expect(200);
  const tokens = await getAccessToken(member, clients.datahub);

  expect(tokens.status, JSON.stringify(tokens.body)).toBe(200);

  return {
    agent: member,
    email,
    userId: await userIdOf(email),
    refreshToken: tokens.body.refresh_token as string | undefined,
    sid: decodeJwt(tokens.body.id_token as string).sid as string,
  };
}

async function refreshStatus(clients: Clients, refreshToken: string | undefined) {
  const res = await agent()
    .post("/api/auth/oauth2/token")
    .auth(clients.datahub.clientId, clients.datahub.clientSecret)
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: refreshToken, resource: process.env.DATAHUB_RESOURCE });

  return res.status;
}

describe("back-channel logout on account and organization removal", () => {
  beforeEach(async () => {
    await resetDb();
    received = [];
  });

  it("notifies client apps when a user confirms the deletion of their own account", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);
    const member = await addMemberWithTokens(clients, owner, organizationId);

    await member.agent.post("/api/account/deletion").expect(200);
    const mail = await waitForEmail(member.email, { subject: /suppression/ });
    const token = extractLink(mail.text).url.searchParams.get("token")!;

    await member.agent.post("/api/account/deletion/confirm").send({ token }).expect(200);
    const [logoutToken] = await waitForTokens(1);

    await expectLogoutToken(logoutToken!, clients, { sid: member.sid, sub: member.userId });
    expect(await db.select().from(schema.session).where(eq(schema.session.userId, member.userId))).toHaveLength(0);
    expect(
      await db.select().from(schema.oauthRefreshToken).where(eq(schema.oauthRefreshToken.userId, member.userId)),
    ).toHaveLength(0);
    expect((await owner.get("/api/auth/get-session").expect(200)).body.user).toBeTruthy();
  });

  it("notifies client apps when an admin deletes a user", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId, adminAgent } = await setupOrgWithOwner(["datahub"]);
    const member = await addMemberWithTokens(clients, owner, organizationId);

    await adminAgent.delete(`/api/admin/users/${member.userId}`).expect(200);
    const [logoutToken] = await waitForTokens(1);

    await expectLogoutToken(logoutToken!, clients, { sid: member.sid, sub: member.userId });
    expect(await refreshStatus(clients, member.refreshToken)).toBe(400);
    expect(await db.select().from(schema.session).where(eq(schema.session.userId, member.userId))).toHaveLength(0);
  });

  it("notifies client apps when the retention job pseudonymizes an inactive account without any request", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);
    const member = await addMemberWithTokens(clients, owner, organizationId);
    const longAgo = new Date(Date.now() - 4 * 365 * 86_400_000);

    await db
      .update(schema.user)
      .set({ lastActiveAt: longAgo, inactivityWarnedAt: new Date(Date.now() - 40 * 86_400_000) })
      .where(eq(schema.user.id, member.userId));

    const result = await runRetentionOnce();

    expect(result?.accounts.deleted).toBe(1);
    const [logoutToken] = await waitForTokens(1);

    await expectLogoutToken(logoutToken!, clients, { sid: member.sid, sub: member.userId });
    expect(await refreshStatus(clients, member.refreshToken)).toBe(400);
    expect((await owner.get("/api/auth/get-session").expect(200)).body.user).toBeTruthy();
  });

  it("logs out only the sessions bound to a deleted organization", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId, adminAgent } = await setupOrgWithOwner(["datahub"]);
    const other = await setupOrgWithOwner(["datahub"]);
    const member = await addMemberWithTokens(clients, owner, organizationId);
    const bystander = await addMemberWithTokens(clients, other.owner, other.organizationId);
    const [org] = await db
      .select({ slug: schema.organization.slug })
      .from(schema.organization)
      .where(eq(schema.organization.id, organizationId));

    await adminAgent.delete(`/api/admin/organizations/${organizationId}`).send({ confirm: org!.slug }).expect(200);
    const [logoutToken] = await waitForTokens(1);

    await expectLogoutToken(logoutToken!, clients, { sid: member.sid, sub: member.userId });
    expect(await refreshStatus(clients, member.refreshToken)).toBe(400);
    expect(await db.select().from(schema.session).where(eq(schema.session.id, member.sid))).toHaveLength(0);
    expect(await db.select().from(schema.session).where(eq(schema.session.id, bystander.sid))).toHaveLength(1);
    expect(await refreshStatus(clients, bystander.refreshToken)).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(1);
  });
});

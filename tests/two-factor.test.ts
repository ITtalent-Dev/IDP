import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../server/lib/db/index";
import { ORGANIZATION_CLAIM } from "../server/lib/auth/access-claims";
import { userVerifiedFlag } from "../server/lib/auth/two-factor-policy";
import { agent, resetDb, setupOrgWithOwner, type Agent } from "./helpers";
import { fakeCode, type FakeProfile } from "./helpers/fake-idp";
import { authorize, exchangeCode, getAccessToken, seedTestClients, verifyJwt } from "./helpers/oauth";

const RESOURCE = process.env.PLATFORM_RESOURCE!;

async function signInWithAuthentik(profile: Omit<FakeProfile, "nonce">) {
  const a = agent();
  const start = await a.post("/api/auth/sign-in/social").send({ provider: "authentik", callbackURL: "/admin" });
  const authUrl = new URL(start.body.url);
  const redirect = new URL(authUrl.searchParams.get("redirect_uri")!);
  const code = fakeCode({ ...profile, nonce: authUrl.searchParams.get("nonce") ?? undefined });
  const callback = await a.get(`${redirect.pathname}?code=${code}&state=${authUrl.searchParams.get("state")}`);

  return { agent: a, callback };
}

async function requireTwoFactor(owner: Agent, organizationId: string) {
  const res = await owner
    .post("/api/auth/organization/update")
    .send({ organizationId, data: { requireTwoFactor: true } });

  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

const userIdByEmail = async (email: string) =>
  (await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email)).limit(1))[0]!.id;

describe("two-factor authentication", () => {
  beforeEach(resetDb);

  it("refuses staff sign-ins for which Authentik ran no second factor", async () => {
    const refused = await signInWithAuthentik({ sub: "ak-pwd", email: "pwd-only@staff.test", amr: ["pwd"] });

    expect(refused.callback.status).toBe(302);
    expect(refused.callback.headers.location).toContain("error=");
    expect((await refused.agent.get("/api/auth/get-session")).body).toBeNull();

    const accepted = await signInWithAuthentik({ sub: "ak-mfa", email: "mfa@staff.test", amr: ["pwd", "mfa"] });

    expect(accepted.callback.headers.location).not.toContain("error=");
    expect((await accepted.agent.get("/api/auth/get-session")).body.user.role).toBe("admin");
  });

  it("lets owners and admins require it, and records the admin change", async () => {
    const { owner, organizationId, adminAgent } = await setupOrgWithOwner(["datahub"]);

    await requireTwoFactor(owner, organizationId);
    const [org] = await db.select().from(schema.organization).where(eq(schema.organization.id, organizationId));

    expect(org!.requireTwoFactor).toBe(true);

    await adminAgent.patch(`/api/admin/organizations/${organizationId}`).send({ requireTwoFactor: false }).expect(200);
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "organization.security.update"));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toEqual({ requireTwoFactor: false });
  });

  it("refuses magic links to members of an organization that requires it", async () => {
    const { owner, organizationId, ownerEmail } = await setupOrgWithOwner(["datahub"]);

    await agent().post("/api/auth/sign-in/magic-link").send({ email: ownerEmail, callbackURL: "/" }).expect(200);
    await requireTwoFactor(owner, organizationId);
    const res = await agent().post("/api/auth/sign-in/magic-link").send({ email: ownerEmail, callbackURL: "/" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("TWO_FACTOR_PASSWORD_REQUIRED");
  });

  it("issues no app token until the required second factor is enabled", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId, ownerEmail } = await setupOrgWithOwner(["datahub"]);

    await requireTwoFactor(owner, organizationId);

    const blocked = await authorize(owner, clients.platform);

    expect(blocked.code).toBeUndefined();
    expect(blocked.location).toContain("/select-organization");

    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.id, await userIdByEmail(ownerEmail)));
    const res = await getAccessToken(owner, clients.platform);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await verifyJwt(res.body.access_token, RESOURCE))[ORGANIZATION_CLAIM]).toBe(organizationId);
  });

  it("counts a passkey as the required second factor and refuses magic links for its owner", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId, ownerEmail } = await setupOrgWithOwner(["datahub"]);

    await requireTwoFactor(owner, organizationId);
    await db
      .update(schema.user)
      .set({ hasPasskey: true })
      .where(eq(schema.user.id, await userIdByEmail(ownerEmail)));

    const res = await getAccessToken(owner, clients.platform);

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    await db
      .update(schema.organization)
      .set({ requireTwoFactor: false })
      .where(eq(schema.organization.id, organizationId));
    const magic = await agent().post("/api/auth/sign-in/magic-link").send({ email: ownerEmail, callbackURL: "/" });

    expect(magic.status).toBe(403);
  });

  it("refuses passkey assertions in which the device did not verify the user", async () => {
    const authenticatorData = (flags: number) => {
      const bytes = Buffer.alloc(37);

      bytes[32] = flags;

      return bytes.toString("base64url");
    };

    expect(userVerifiedFlag(authenticatorData(0x01))).toBe(false);
    expect(userVerifiedFlag(authenticatorData(0x05))).toBe(true);

    const res = await agent()
      .post("/api/auth/passkey/verify-authentication")
      .send({
        response: { id: "x", rawId: "x", type: "public-key", response: { authenticatorData: authenticatorData(0x01) } },
      });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("PASSKEY_USER_VERIFICATION_REQUIRED");
  });

  it("lets an admin reset a user's second factors, ending their sessions", async () => {
    const { owner, ownerEmail, adminAgent, admin } = await setupOrgWithOwner(["datahub"]);
    const userId = await userIdByEmail(ownerEmail);

    await db.update(schema.user).set({ twoFactorEnabled: true, hasPasskey: true }).where(eq(schema.user.id, userId));
    await db.insert(schema.passkey).values({
      id: "pk-test",
      userId,
      publicKey: "key",
      credentialID: "cred",
      counter: 0,
      deviceType: "multiDevice",
      backedUp: true,
    });

    await adminAgent.post(`/api/admin/users/${userId}/two-factor/reset`).expect(200);

    const [user] = await db.select().from(schema.user).where(eq(schema.user.id, userId));

    expect(user).toMatchObject({ twoFactorEnabled: false, hasPasskey: false });
    expect(await db.select().from(schema.passkey).where(eq(schema.passkey.userId, userId))).toHaveLength(0);
    expect((await owner.get("/api/auth/get-session")).body).toBeNull();
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "user.two_factor.reset"));

    expect(rows[0]).toMatchObject({ targetId: userId, metadata: { totp: true, passkeys: 1 } });

    await adminAgent.post(`/api/admin/users/${admin.id}/two-factor/reset`).expect(400);
  });

  it("lets an impersonating admin act without the user's second factor", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId, ownerEmail, adminAgent } = await setupOrgWithOwner(["datahub"]);

    await requireTwoFactor(owner, organizationId);
    await adminAgent
      .post("/api/auth/admin/impersonate-user")
      .send({ userId: await userIdByEmail(ownerEmail) })
      .expect(200);

    const auth = await authorize(adminAgent, clients.platform, { scope: "openid profile email" });

    expect(auth.code, auth.location).toBeDefined();
    const res = await exchangeCode(clients.platform, {
      code: auth.code!,
      verifier: auth.verifier,
      redirectUri: auth.redirectUri,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { eq } from "drizzle-orm";
import { db, schema } from "../server/lib/db/index";
import {
  ACCESS_CLAIM,
  buildAccessTokenClaims,
  IMPERSONATED_BY_CLAIM,
  ORGANIZATION_CLAIM,
  ORGANIZATION_COUNT_CLAIM,
  ORGANIZATION_NAME_CLAIM,
} from "../server/lib/auth/access-claims";
import { seedClients } from "../server/lib/oauth/clients";
import { agent, createUser, resetDb, setupOrgWithOwner, signIn, type Agent } from "./helpers/index";
import { authorize, exchangeCode, getAccessToken, seedTestClients, verifyJwt } from "./helpers/oauth";

const DATAHUB = process.env.DATAHUB_RESOURCE!;
const APP = process.env.AGO_RESOURCE!;

async function inviteAndJoin(owner: Agent, organizationId: string, role: string) {
  const user = await createUser();
  const inv = await owner
    .post("/api/auth/organization/invite-member")
    .send({ email: user.email, role, organizationId })
    .expect(200);
  const a = await signIn(user.email);

  await a.post("/api/auth/organization/accept-invitation").send({ invitationId: inv.body.id }).expect(200);

  return { user, agent: a };
}

describe("client seeding", () => {
  beforeEach(resetDb);

  it("is idempotent and binds each client to its own resource only", async () => {
    const first = await seedClients();

    expect(first.every((c) => c.created && c.clientSecret)).toBe(true);
    const second = await seedClients();

    expect(second.every((c) => !c.created && !c.clientSecret)).toBe(true);
    expect(second.map((c) => c.clientId)).toEqual(first.map((c) => c.clientId));

    const links = await db.select().from(schema.oauthClientResource);

    expect(links).toHaveLength(2);
    for (const c of second) {
      expect(links.filter((l) => l.clientId === c.clientId).map((l) => l.resourceId)).toEqual([c.resource]);
    }

    const clients = await db.select().from(schema.oauthClient);

    expect(clients.every((c) => c.skipConsent)).toBe(true);
  });
});

describe("access tokens", () => {
  beforeEach(resetDb);

  it("issues a JWT whose audience is the requested resource and carries the access claim", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["datahub", "ago"]);

    const res = await getAccessToken(owner, clients.datahub);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.refresh_token).toBeTruthy();
    expect(res.body.expires_in).toBeLessThanOrEqual(600);

    const payload = await verifyJwt(res.body.access_token, DATAHUB);

    expect(payload.aud).toContain(DATAHUB);
    expect(payload.aud).not.toContain(APP);
    expect(payload[ACCESS_CLAIM]).toEqual({ [organizationId]: ["access", "import", "import-read"] });
    expect(payload[IMPERSONATED_BY_CLAIM]).toBeUndefined();
    expect(payload.exp! - payload.iat!).toBe(600);
  });

  it("names the user and the organization so apps can personalize their screens", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId, ownerEmail } = await setupOrgWithOwner(["datahub"]);

    const first = await verifyJwt((await getAccessToken(owner, clients.datahub)).body.access_token, DATAHUB);
    const [org] = await db.select().from(schema.organization).where(eq(schema.organization.id, organizationId));

    expect(first[ORGANIZATION_CLAIM]).toBe(organizationId);
    expect(first[ORGANIZATION_NAME_CLAIM]).toBe(org!.name);
    expect(first).toMatchObject({ name: "Invited", email: ownerEmail });

    await owner
      .post("/api/auth/organization/update")
      .send({ organizationId, data: { name: "Acme Renamed" } })
      .expect(200);
    const second = await verifyJwt((await getAccessToken(owner, clients.datahub)).body.access_token, DATAHUB);

    expect(second[ORGANIZATION_NAME_CLAIM]).toBe("Acme Renamed");
  });

  it("rejects a token issued for one app when verified by the other", async () => {
    const clients = await seedTestClients();
    const { owner } = await setupOrgWithOwner(["datahub", "ago"]);

    const datahubToken = (await getAccessToken(owner, clients.datahub)).body.access_token;
    const appToken = (await getAccessToken(owner, clients.ago)).body.access_token;

    await expect(verifyJwt(datahubToken, APP)).rejects.toThrow(/aud/);
    await expect(verifyJwt(appToken, DATAHUB)).rejects.toThrow(/aud/);
    expect((await verifyJwt(appToken, APP)).aud).toContain(APP);
  });

  it("uses the resource as the only audience when openid is not requested", async () => {
    const clients = await seedTestClients();
    const { owner } = await setupOrgWithOwner(["datahub"]);
    const auth = await authorize(owner, clients.datahub, { scope: "offline_access" });
    const res = await exchangeCode(clients.datahub, {
      code: auth.code!,
      verifier: auth.verifier,
      redirectUri: auth.redirectUri,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await verifyJwt(res.body.access_token, DATAHUB)).aud).toBe(DATAHUB);
  });

  it("does not let a client request another app's resource", async () => {
    const clients = await seedTestClients();
    const { owner } = await setupOrgWithOwner(["datahub", "ago"]);

    const auth = await authorize(owner, clients.datahub, { resource: APP });

    expect(auth.code).toBeUndefined();
    expect(auth.location).toContain("error=");

    const ok = await authorize(owner, clients.datahub);
    const res = await exchangeCode(clients.datahub, {
      code: ok.code!,
      verifier: ok.verifier,
      redirectUri: ok.redirectUri,
      resource: APP,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("intersects role permissions with the organization ceiling", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId, adminAgent } = await setupOrgWithOwner(["datahub", "ago"]);

    await owner
      .post("/api/auth/organization/create-role")
      .send({ organizationId, role: "analyst", permission: { datahub: ["access", "import-read"], ago: ["access"] } })
      .expect(200);
    const analyst = await inviteAndJoin(owner, organizationId, "analyst");

    let payload = decodeJwt((await getAccessToken(analyst.agent, clients.datahub)).body.access_token);

    expect(payload[ACCESS_CLAIM]).toEqual({ [organizationId]: ["access", "import-read"] });

    await adminAgent
      .patch(`/api/admin/organizations/${organizationId}`)
      .send({ apps: ["datahub"] })
      .expect(200);

    payload = decodeJwt((await getAccessToken(analyst.agent, clients.datahub)).body.access_token);
    expect(payload[ACCESS_CLAIM]).toEqual({ [organizationId]: ["access", "import-read"] });

    const denied = await authorize(analyst.agent, clients.ago);

    if (denied.code) {
      const res = await exchangeCode(clients.ago, {
        code: denied.code,
        verifier: denied.verifier,
        redirectUri: denied.redirectUri,
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.access_token).toBeUndefined();
    } else {
      expect(denied.location).toContain("error=");
    }
  });

  it("lets a custom role hold import-read without import", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);

    await owner
      .post("/api/auth/organization/create-role")
      .send({ organizationId, role: "import-viewer", permission: { datahub: ["access", "import-read"] } })
      .expect(200);
    const viewer = await inviteAndJoin(owner, organizationId, "import-viewer");

    const payload = decodeJwt((await getAccessToken(viewer.agent, clients.datahub)).body.access_token);

    expect(payload[ACCESS_CLAIM]).toEqual({ [organizationId]: ["access", "import-read"] });
  });

  it("ignores legacy actions stored in a custom role", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);

    await db.insert(schema.organizationRole).values({
      id: "legacy-role",
      organizationId,
      role: "legacy",
      permission: JSON.stringify({ datahub: ["access", "export", "admin", "import-read"] }),
      createdAt: new Date(),
    });
    const legacy = await inviteAndJoin(owner, organizationId, "legacy");

    const payload = decodeJwt((await getAccessToken(legacy.agent, clients.datahub)).body.access_token);

    expect(payload[ACCESS_CLAIM]).toEqual({ [organizationId]: ["access", "import-read"] });
  });

  it("issues no token when no organization grants access", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);
    const plain = await inviteAndJoin(owner, organizationId, "member");

    const auth = await authorize(plain.agent, clients.datahub);

    expect(auth.code).toBeDefined();
    const res = await exchangeCode(clients.datahub, {
      code: auth.code!,
      verifier: auth.verifier,
      redirectUri: auth.redirectUri,
    });

    expect(res.status).toBe(403);
    expect(res.body.access_token).toBeUndefined();
    expect(res.body.error).toBe("access_denied");

    const outsider = await signIn((await createUser()).email);
    const out = await authorize(outsider, clients.datahub);
    const res2 = await exchangeCode(clients.datahub, {
      code: out.code!,
      verifier: out.verifier,
      redirectUri: out.redirectUri,
    });

    expect(res2.status).toBe(403);
  });

  it("scopes the token to the organization selected during authorization", async () => {
    const clients = await seedTestClients();
    const first = await setupOrgWithOwner(["datahub"]);
    const second = await setupOrgWithOwner(["datahub"]);

    await second.owner
      .post("/api/auth/organization/create-role")
      .send({ organizationId: second.organizationId, role: "reader", permission: { datahub: ["access"] } })
      .expect(200);
    const firstOwner = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.email, first.ownerEmail));
    const inv = await second.owner
      .post("/api/auth/organization/invite-member")
      .send({ email: firstOwner[0]!.email, role: "reader", organizationId: second.organizationId })
      .expect(200);

    await first.owner.post("/api/auth/organization/accept-invitation").send({ invitationId: inv.body.id }).expect(200);

    const auth = await authorize(first.owner, clients.datahub);

    expect(auth.location).toContain("/select-organization");
    const oauthQuery = new URL(auth.location, "http://x").search.slice(1);

    await first.owner
      .post("/api/auth/organization/set-active")
      .send({ organizationId: second.organizationId })
      .expect(200);
    const cont = await first.owner.post("/api/auth/oauth2/continue").send({ postLogin: true, oauth_query: oauthQuery });

    expect(cont.status, JSON.stringify(cont.body)).toBe(200);
    const code = new URL(cont.body.url).searchParams.get("code")!;
    const res = await exchangeCode(clients.datahub, { code, verifier: auth.verifier, redirectUri: auth.redirectUri });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const payload = decodeJwt(res.body.access_token);

    expect(payload[ACCESS_CLAIM]).toEqual({ [second.organizationId]: ["access"] });
    expect(payload[ORGANIZATION_CLAIM]).toBe(second.organizationId);
    expect(payload[ORGANIZATION_COUNT_CLAIM]).toBe(2);

    const refreshed = await agent()
      .post("/api/auth/oauth2/token")
      .auth(clients.datahub.clientId, clients.datahub.clientSecret)
      .type("form")
      .send({ grant_type: "refresh_token", refresh_token: res.body.refresh_token, resource: DATAHUB });

    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(decodeJwt(refreshed.body.access_token)[ORGANIZATION_CLAIM]).toBe(second.organizationId);
  });

  it("shows the organization choice when the app asks for it, even with a single organization", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);

    const direct = await authorize(owner, clients.datahub);

    expect(direct.code).toBeTruthy();

    const auth = await authorize(owner, clients.datahub, { prompt: "select_account" });

    expect(auth.code).toBeUndefined();
    expect(auth.location).toContain("/select-organization");
    const oauthQuery = new URL(auth.location, "http://x").search.slice(1);

    expect(new URLSearchParams(oauthQuery).get("prompt")).toBe("select_account");

    await owner.post("/api/auth/organization/set-active").send({ organizationId }).expect(200);
    const cont = await owner.post("/api/auth/oauth2/continue").send({ selected: true, oauth_query: oauthQuery });

    expect(cont.status, JSON.stringify(cont.body)).toBe(200);
    const code = new URL(cont.body.url).searchParams.get("code")!;
    const res = await exchangeCode(clients.datahub, { code, verifier: auth.verifier, redirectUri: auth.redirectUri });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const payload = decodeJwt(res.body.access_token);

    expect(payload[ORGANIZATION_CLAIM]).toBe(organizationId);
    expect(payload[ORGANIZATION_COUNT_CLAIM]).toBe(1);
  });

  it("refuses to pick an organization on the user's behalf", async () => {
    const orgA = await setupOrgWithOwner(["datahub"]);
    const orgB = await setupOrgWithOwner(["datahub"]);
    const [user] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, orgA.ownerEmail));

    await db.insert(schema.member).values({
      id: `member-${Date.now()}`,
      organizationId: orgB.organizationId,
      userId: user!.id,
      role: "owner",
      createdAt: new Date(),
    });
    await expect(buildAccessTokenClaims({ user: { id: user!.id }, resources: [DATAHUB] })).rejects.toThrow();
    await expect(
      buildAccessTokenClaims({ user: { id: user!.id }, resources: [DATAHUB], referenceId: "not-a-member-org" }),
    ).rejects.toThrow();
    const claims = await buildAccessTokenClaims({
      user: { id: user!.id },
      resources: [DATAHUB],
      referenceId: orgB.organizationId,
    });

    expect(claims[ACCESS_CLAIM]).toEqual({
      [orgB.organizationId]: ["access", "import", "import-read"],
    });
  });

  it("refreshes tokens with offline_access and recomputes the claim", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);
    const first = await getAccessToken(owner, clients.datahub);
    const refreshed = await agent()
      .post("/api/auth/oauth2/token")
      .auth(clients.datahub.clientId, clients.datahub.clientSecret)
      .type("form")
      .send({ grant_type: "refresh_token", refresh_token: first.body.refresh_token, resource: DATAHUB });

    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    const payload = await verifyJwt(refreshed.body.access_token, DATAHUB);

    expect(payload[ACCESS_CLAIM]).toEqual({ [organizationId]: ["access", "import", "import-read"] });
  });

  it("publishes OIDC discovery with the configured issuer", async () => {
    await seedTestClients();
    const res = await agent().get("/api/auth/.well-known/openid-configuration").expect(200);

    expect(res.body.issuer).toBe(`${process.env.AUTH_BASE_URL}/api/auth`);
    expect(res.body.jwks_uri).toContain("/api/auth/jwks");
  });

  it("adds no custom claim to machine-to-machine tokens", async () => {
    expect(await buildAccessTokenClaims({ user: undefined, resources: [DATAHUB] })).toEqual({});
  });

  it("only lets admins manage OAuth clients", async () => {
    const user = await createUser();
    const a = await signIn(user.email);
    const res = await a
      .post("/api/auth/oauth2/create-client")
      .send({ redirect_uris: ["https://evil.test/cb"], client_name: "Evil" });

    expect(res.status).toBe(401);
    await a
      .post("/api/auth/oauth2/register")
      .send({ redirect_uris: ["https://evil.test/cb"] })
      .expect((r) => {
        if (r.status < 400) throw new Error("dynamic registration must be disabled");
      });
  });
});

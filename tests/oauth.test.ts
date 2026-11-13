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

const RESOURCE = process.env.PLATFORM_RESOURCE!;
const UNKNOWN_RESOURCE = "https://unknown.test";

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

  it("is idempotent and binds the platform client to the platform resource only", async () => {
    const first = await seedClients();

    expect(first.created && first.clientSecret).toBeTruthy();
    const second = await seedClients();

    expect(second.created).toBe(false);
    expect(second.clientSecret).toBeUndefined();
    expect(second.clientId).toBe(first.clientId);

    const links = await db.select().from(schema.oauthClientResource);

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ clientId: second.clientId, resourceId: RESOURCE });

    const clients = await db.select().from(schema.oauthClient);

    expect(clients.every((c) => c.skipConsent)).toBe(true);
  });
});

describe("access tokens", () => {
  beforeEach(resetDb);

  it("issues a JWT whose audience is the requested resource and carries the access claim", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["datahub", "ago"]);

    const res = await getAccessToken(owner, clients.platform);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.refresh_token).toBeTruthy();
    expect(res.body.expires_in).toBeLessThanOrEqual(600);

    const payload = await verifyJwt(res.body.access_token, RESOURCE);

    expect(payload.aud).toContain(RESOURCE);
    expect(payload[ACCESS_CLAIM]).toEqual({
      [organizationId]: [
        "datahub:access",
        "datahub:import",
        "datahub:import-read",
        "ago:access",
        "ago:admin",
        "ago:print",
      ],
    });
    expect(payload[IMPERSONATED_BY_CLAIM]).toBeUndefined();
    expect(payload.exp! - payload.iat!).toBe(600);
  });

  it("names the user and the organization so apps can personalize their screens", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId, ownerEmail } = await setupOrgWithOwner(["datahub"]);

    const first = await verifyJwt((await getAccessToken(owner, clients.platform)).body.access_token, RESOURCE);
    const [org] = await db.select().from(schema.organization).where(eq(schema.organization.id, organizationId));

    expect(first[ORGANIZATION_CLAIM]).toBe(organizationId);
    expect(first[ORGANIZATION_NAME_CLAIM]).toBe(org!.name);
    expect(first).toMatchObject({ name: "Invited", email: ownerEmail });

    await owner
      .post("/api/auth/organization/update")
      .send({ organizationId, data: { name: "Acme Renamed" } })
      .expect(200);
    const second = await verifyJwt((await getAccessToken(owner, clients.platform)).body.access_token, RESOURCE);

    expect(second[ORGANIZATION_NAME_CLAIM]).toBe("Acme Renamed");
  });

  it("REJECT_PLACEHOLDER", async () => {});

  it("rejects a token verified for another audience", async () => {
    const clients = await seedTestClients();
    const { owner } = await setupOrgWithOwner(["datahub", "ago"]);
    const token = (await getAccessToken(owner, clients.platform)).body.access_token;

    await expect(verifyJwt(token, UNKNOWN_RESOURCE)).rejects.toThrow(/aud/);
  });

  it("only prefixes the permissions of the modules enabled for the organization", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["ago"]);
    const payload = decodeJwt((await getAccessToken(owner, clients.platform)).body.access_token);

    expect(payload[ACCESS_CLAIM]).toEqual({ [organizationId]: ["ago:access", "ago:admin", "ago:print"] });
  });

  it("gives the permissions of a module granted by a role only when the module is enabled", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId, adminAgent } = await setupOrgWithOwner(["datahub", "ago"]);

    await owner
      .post("/api/auth/organization/create-role")
      .send({ organizationId, role: "mixed", permission: { datahub: ["access"], ago: ["access", "print"] } })
      .expect(200);
    const mixed = await inviteAndJoin(owner, organizationId, "mixed");

    let payload = decodeJwt((await getAccessToken(mixed.agent, clients.platform)).body.access_token);

    expect(payload[ACCESS_CLAIM]).toEqual({ [organizationId]: ["datahub:access", "ago:access", "ago:print"] });

    await adminAgent
      .patch(`/api/admin/organizations/${organizationId}`)
      .send({ apps: ["datahub"] })
      .expect(200);
    payload = decodeJwt((await getAccessToken(mixed.agent, clients.platform)).body.access_token);
    expect(payload[ACCESS_CLAIM]).toEqual({ [organizationId]: ["datahub:access"] });
  });

  it("refuses a user who has access in no module", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["datahub", "ago"]);

    await db.insert(schema.organizationRole).values({
      id: "importer-role",
      organizationId,
      role: "importer",
      permission: JSON.stringify({ datahub: ["import"], ago: ["print"] }),
      createdAt: new Date(),
    });
    const importer = await inviteAndJoin(owner, organizationId, "importer");
    const auth = await authorize(importer.agent, clients.platform);
    const res = await exchangeCode(clients.platform, {
      code: auth.code!,
      verifier: auth.verifier,
      redirectUri: auth.redirectUri,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("access_denied");
    expect(res.body.access_token).toBeUndefined();
  });

  it("uses the resource as the only audience when openid is not requested", async () => {
    const clients = await seedTestClients();
    const { owner } = await setupOrgWithOwner(["datahub"]);
    const auth = await authorize(owner, clients.platform, { scope: "offline_access" });
    const res = await exchangeCode(clients.platform, {
      code: auth.code!,
      verifier: auth.verifier,
      redirectUri: auth.redirectUri,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await verifyJwt(res.body.access_token, RESOURCE)).aud).toBe(RESOURCE);
  });

  it("does not let a client request an unknown resource", async () => {
    const clients = await seedTestClients();
    const { owner } = await setupOrgWithOwner(["datahub", "ago"]);

    const auth = await authorize(owner, clients.platform, { resource: UNKNOWN_RESOURCE });

    expect(auth.code).toBeUndefined();
    expect(auth.location).toContain("error=");

    const ok = await authorize(owner, clients.platform);
    const res = await exchangeCode(clients.platform, {
      code: ok.code!,
      verifier: ok.verifier,
      redirectUri: ok.redirectUri,
      resource: UNKNOWN_RESOURCE,
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

    let payload = decodeJwt((await getAccessToken(analyst.agent, clients.platform)).body.access_token);

    expect(payload[ACCESS_CLAIM]).toEqual({
      [organizationId]: ["datahub:access", "datahub:import-read", "ago:access"],
    });

    await adminAgent
      .patch(`/api/admin/organizations/${organizationId}`)
      .send({ apps: ["datahub"] })
      .expect(200);

    payload = decodeJwt((await getAccessToken(analyst.agent, clients.platform)).body.access_token);
    expect(payload[ACCESS_CLAIM]).toEqual({ [organizationId]: ["datahub:access", "datahub:import-read"] });
  });

  it("lets a custom role hold import-read without import", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);

    await owner
      .post("/api/auth/organization/create-role")
      .send({ organizationId, role: "import-viewer", permission: { datahub: ["access", "import-read"] } })
      .expect(200);
    const viewer = await inviteAndJoin(owner, organizationId, "import-viewer");

    const payload = decodeJwt((await getAccessToken(viewer.agent, clients.platform)).body.access_token);

    expect(payload[ACCESS_CLAIM]).toEqual({ [organizationId]: ["datahub:access", "datahub:import-read"] });
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

    const payload = decodeJwt((await getAccessToken(legacy.agent, clients.platform)).body.access_token);

    expect(payload[ACCESS_CLAIM]).toEqual({ [organizationId]: ["datahub:access", "datahub:import-read"] });
  });

  it("issues no token when no organization grants access", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);
    const plain = await inviteAndJoin(owner, organizationId, "member");

    const auth = await authorize(plain.agent, clients.platform);

    expect(auth.code).toBeDefined();
    const res = await exchangeCode(clients.platform, {
      code: auth.code!,
      verifier: auth.verifier,
      redirectUri: auth.redirectUri,
    });

    expect(res.status).toBe(403);
    expect(res.body.access_token).toBeUndefined();
    expect(res.body.error).toBe("access_denied");

    const outsider = await signIn((await createUser()).email);
    const out = await authorize(outsider, clients.platform);
    const res2 = await exchangeCode(clients.platform, {
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

    const auth = await authorize(first.owner, clients.platform);

    expect(auth.location).toContain("/select-organization");
    const oauthQuery = new URL(auth.location, "http://x").search.slice(1);

    await first.owner
      .post("/api/auth/organization/set-active")
      .send({ organizationId: second.organizationId })
      .expect(200);
    const cont = await first.owner.post("/api/auth/oauth2/continue").send({ postLogin: true, oauth_query: oauthQuery });

    expect(cont.status, JSON.stringify(cont.body)).toBe(200);
    const code = new URL(cont.body.url).searchParams.get("code")!;
    const res = await exchangeCode(clients.platform, { code, verifier: auth.verifier, redirectUri: auth.redirectUri });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const payload = decodeJwt(res.body.access_token);

    expect(payload[ACCESS_CLAIM]).toEqual({ [second.organizationId]: ["datahub:access"] });
    expect(payload[ORGANIZATION_CLAIM]).toBe(second.organizationId);
    expect(payload[ORGANIZATION_COUNT_CLAIM]).toBe(2);

    const refreshed = await agent()
      .post("/api/auth/oauth2/token")
      .auth(clients.platform.clientId, clients.platform.clientSecret)
      .type("form")
      .send({ grant_type: "refresh_token", refresh_token: res.body.refresh_token, resource: RESOURCE });

    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(decodeJwt(refreshed.body.access_token)[ORGANIZATION_CLAIM]).toBe(second.organizationId);
  });

  it("shows the organization choice when the app asks for it, even with a single organization", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);

    const direct = await authorize(owner, clients.platform);

    expect(direct.code).toBeTruthy();

    const auth = await authorize(owner, clients.platform, { prompt: "select_account" });

    expect(auth.code).toBeUndefined();
    expect(auth.location).toContain("/select-organization");
    const oauthQuery = new URL(auth.location, "http://x").search.slice(1);

    expect(new URLSearchParams(oauthQuery).get("prompt")).toBe("select_account");

    await owner.post("/api/auth/organization/set-active").send({ organizationId }).expect(200);
    const cont = await owner.post("/api/auth/oauth2/continue").send({ selected: true, oauth_query: oauthQuery });

    expect(cont.status, JSON.stringify(cont.body)).toBe(200);
    const code = new URL(cont.body.url).searchParams.get("code")!;
    const res = await exchangeCode(clients.platform, { code, verifier: auth.verifier, redirectUri: auth.redirectUri });

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
    await expect(buildAccessTokenClaims({ user: { id: user!.id }, resources: [RESOURCE] })).rejects.toThrow();
    await expect(
      buildAccessTokenClaims({ user: { id: user!.id }, resources: [RESOURCE], referenceId: "not-a-member-org" }),
    ).rejects.toThrow();
    const claims = await buildAccessTokenClaims({
      user: { id: user!.id },
      resources: [RESOURCE],
      referenceId: orgB.organizationId,
    });

    expect(claims[ACCESS_CLAIM]).toEqual({
      [orgB.organizationId]: ["datahub:access", "datahub:import", "datahub:import-read"],
    });
  });

  it("refreshes tokens with offline_access and recomputes the claim", async () => {
    const clients = await seedTestClients();
    const { owner, organizationId } = await setupOrgWithOwner(["datahub"]);
    const first = await getAccessToken(owner, clients.platform);
    const refreshed = await agent()
      .post("/api/auth/oauth2/token")
      .auth(clients.platform.clientId, clients.platform.clientSecret)
      .type("form")
      .send({ grant_type: "refresh_token", refresh_token: first.body.refresh_token, resource: RESOURCE });

    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    const payload = await verifyJwt(refreshed.body.access_token, RESOURCE);

    expect(payload[ACCESS_CLAIM]).toEqual({
      [organizationId]: ["datahub:access", "datahub:import", "datahub:import-read"],
    });
  });

  it("publishes OIDC discovery with the configured issuer", async () => {
    await seedTestClients();
    const res = await agent().get("/api/auth/.well-known/openid-configuration").expect(200);

    expect(res.body.issuer).toBe(`${process.env.AUTH_BASE_URL}/api/auth`);
    expect(res.body.jwks_uri).toContain("/api/auth/jwks");
  });

  it("adds no custom claim to machine-to-machine tokens", async () => {
    expect(await buildAccessTokenClaims({ user: undefined, resources: [RESOURCE] })).toEqual({});
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

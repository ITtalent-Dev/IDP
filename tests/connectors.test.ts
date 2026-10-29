import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { eq } from "drizzle-orm";
import { db, schema } from "../server/lib/db/index";
import { ACCESS_CLAIM, ORGANIZATION_CLAIM, ORGANIZATION_NAME_CLAIM } from "../server/lib/auth/access-claims";
import { agent, createUser, resetDb, setupOrgWithOwner, signIn, type Agent } from "./helpers/index";
import { ISSUER, verifyJwt } from "./helpers/oauth";
import { TEST_BASE_URL } from "./helpers/test-env";

const DATAHUB = process.env.DATAHUB_RESOURCE!;
const APP = process.env.APP_RESOURCE!;
const TOKEN_ENDPOINT = `${TEST_BASE_URL}/api/auth/oauth2/token`;
const CONNECTOR_CLAIM = `${process.env.CLAIMS_NAMESPACE}/connector_id`;
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

interface Machine {
  publicJwk: JWK;
  privateKey: CryptoKey;
}

async function newMachine(): Promise<Machine> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });

  return { publicJwk: await exportJWK(publicKey), privateKey };
}

const startPairing = (machine: Machine, name?: string, kind?: string) =>
  agent().post("/api/connectors/pairing").send({ publicKey: machine.publicJwk, name, kind });

const poll = (deviceCode: string) => agent().post("/api/connectors/pairing/token").send({ deviceCode });

const approve = (user: Agent, body: { userCode: string; organizationId: string; name?: string }) =>
  user.post("/api/account/connectors/pairing/approve").send(body);

function clientAssertion(clientId: string, key: CryptoKey, jti = randomUUID()) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(TOKEN_ENDPOINT)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(key);
}

const requestToken = (assertion: string, resource: string | null = DATAHUB) =>
  agent()
    .post("/api/auth/oauth2/token")
    .type("form")
    .send({
      grant_type: "client_credentials",
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: assertion,
      ...(resource ? { resource } : {}),
    });

async function pairConnector(owner: Agent, organizationId: string, name = "Serveur Lyon", kind?: string) {
  const machine = await newMachine();
  const pairing = (await startPairing(machine, undefined, kind).expect(200)).body;

  await approve(owner, { userCode: pairing.userCode, organizationId, name }).expect(200);
  const credentials = (await poll(pairing.deviceCode).expect(200)).body as { clientId: string };
  const [connector] = await db
    .select()
    .from(schema.connector)
    .where(eq(schema.connector.oauthClientId, credentials.clientId));

  return { machine, clientId: credentials.clientId, connectorId: connector!.id };
}

async function addMember(owner: Agent, organizationId: string) {
  const user = await createUser({ name: "Member" });
  const invitation = await owner
    .post("/api/auth/organization/invite-member")
    .send({ email: user.email, role: "member", organizationId })
    .expect(200);
  const member = await signIn(user.email);
  const accepted = await member
    .post("/api/auth/organization/accept-invitation")
    .send({ invitationId: invitation.body.id })
    .expect(200);

  await member.post("/api/auth/organization/set-active").send({ organizationId }).expect(200);

  return { agent: member, memberId: accepted.body.member.id as string };
}

async function activeOwner(apps: string[] = ["datahub", "app"]) {
  const setup = await setupOrgWithOwner(apps);

  await setup.owner
    .post("/api/auth/organization/set-active")
    .send({ organizationId: setup.organizationId })
    .expect(200);

  return setup;
}

const auditActions = async () => (await db.select().from(schema.auditLog)).map((e) => e.action);

describe("connector pairing", () => {
  beforeEach(resetDb);

  it("pairs a machine end to end and issues an import-only token bound to the organization", async () => {
    const { owner, organizationId } = await activeOwner();
    const machine = await newMachine();

    const started = await startPairing(machine, "Poste accueil").expect(200);
    const pairing = started.body;

    expect(pairing.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(pairing.deviceCode.length).toBeGreaterThanOrEqual(43);
    expect(pairing).toMatchObject({
      verificationUri: `${TEST_BASE_URL}/connectors/pair`,
      verificationUriComplete: `${TEST_BASE_URL}/connectors/pair?code=${pairing.userCode}`,
      expiresIn: 600,
      interval: 5,
    });
    const [stored] = await db.select().from(schema.connectorPairing);

    expect(stored!.deviceCodeHash).not.toContain(pairing.deviceCode);
    expect(JSON.stringify(stored)).not.toContain(pairing.deviceCode);

    const pending = await poll(pairing.deviceCode).expect(400);

    expect(pending.body.error).toBe("authorization_pending");

    const preview = await owner.get("/api/account/connectors/pairing").query({ code: pairing.userCode }).expect(200);

    expect(preview.body.pairing).toMatchObject({ name: "Poste accueil", kind: "import", app: "datahub" });
    const eligible = await owner.get("/api/account/connectors/organizations").expect(200);

    expect(eligible.body.organizations.map((o: { id: string }) => o.id)).toEqual([organizationId]);

    await approve(owner, { userCode: pairing.userCode.toLowerCase(), organizationId }).expect(200);

    const approved = await poll(pairing.deviceCode).expect(200);

    expect(approved.body).toEqual({
      clientId: expect.stringMatching(/^connector-/),
      issuer: ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      resource: DATAHUB,
    });
    expect((await poll(pairing.deviceCode).expect(400)).body.error).toBe("invalid_grant");

    const clientId = approved.body.clientId as string;
    const tokenRes = await requestToken(await clientAssertion(clientId, machine.privateKey));

    expect(tokenRes.status, JSON.stringify(tokenRes.body)).toBe(200);
    expect(tokenRes.body.refresh_token).toBeUndefined();
    expect(tokenRes.body.id_token).toBeUndefined();

    const payload = await verifyJwt(tokenRes.body.access_token, DATAHUB);
    const [connector] = await db.select().from(schema.connector);

    expect(payload.sub).toBe(clientId);
    expect(payload.client_id).toBe(clientId);
    expect(payload.azp).toBe(clientId);
    expect(payload.aud).toBe(DATAHUB);
    expect(payload.exp! - payload.iat!).toBe(600);
    expect(payload[ACCESS_CLAIM]).toEqual({ [organizationId]: ["import"] });
    expect(payload[ORGANIZATION_CLAIM]).toBe(organizationId);
    expect(payload[ORGANIZATION_NAME_CLAIM]).toEqual(expect.any(String));
    expect(payload[CONNECTOR_CLAIM]).toBe(connector!.id);
    expect(Object.keys(payload).sort()).toEqual(
      [
        "iss",
        "sub",
        "aud",
        "exp",
        "iat",
        "jti",
        "client_id",
        "azp",
        "scope",
        ACCESS_CLAIM,
        ORGANIZATION_CLAIM,
        ORGANIZATION_NAME_CLAIM,
        CONNECTOR_CLAIM,
      ].sort(),
    );
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("name");

    expect(connector).toMatchObject({ organizationId, name: "Poste accueil", oauthClientId: clientId });
    expect(connector!.lastUsedAt).toBeInstanceOf(Date);
    const [client] = await db.select().from(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId));

    expect(client).toMatchObject({
      clientSecret: null,
      tokenEndpointAuthMethod: "private_key_jwt",
      grantTypes: ["client_credentials"],
      redirectUris: [],
    });
    expect(JSON.parse(client!.jwks!).keys[0]).not.toHaveProperty("d");
    expect(await auditActions()).toContain("connector.paired");
  });

  it("asks the machine to slow down when it polls faster than the interval", async () => {
    const pairing = (await startPairing(await newMachine()).expect(200)).body;

    expect((await poll(pairing.deviceCode).expect(400)).body.error).toBe("authorization_pending");
    expect((await poll(pairing.deviceCode).expect(400)).body.error).toBe("slow_down");
    const [stored] = await db.select().from(schema.connectorPairing);

    expect(stored!.pollInterval).toBe(10);
  });

  it("expires pairings after ten minutes", async () => {
    const { owner, organizationId } = await activeOwner();
    const pairing = (await startPairing(await newMachine()).expect(200)).body;

    await db.update(schema.connectorPairing).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await poll(pairing.deviceCode).expect(400)).body.error).toBe("expired_token");
    const res = await approve(owner, { userCode: pairing.userCode, organizationId, name: "Late" }).expect(404);

    expect(res.body.code).toBe("PAIRING_NOT_FOUND");
    expect(await db.select().from(schema.connector)).toHaveLength(0);
  });

  it("reports a denied pairing to the machine", async () => {
    const { owner, organizationId } = await activeOwner();
    const pairing = (await startPairing(await newMachine()).expect(200)).body;

    await owner
      .post("/api/account/connectors/pairing/deny")
      .send({ userCode: pairing.userCode, organizationId })
      .expect(200);
    expect((await poll(pairing.deviceCode).expect(400)).body.error).toBe("access_denied");
    expect(await db.select().from(schema.oauthClient)).toHaveLength(0);
    expect(await auditActions()).toContain("connector.pairing.denied");
  });

  it("rejects private keys and keys that are not P-256", async () => {
    const { privateKey } = await newMachine();
    const privateJwk = await exportJWK(privateKey);

    const res = await agent().post("/api/connectors/pairing").send({ publicKey: privateJwk }).expect(400);

    expect(res.body.code).toBe("VALIDATION_ERROR");
    const rsa = await generateKeyPair("RS256", { extractable: true });

    await agent()
      .post("/api/connectors/pairing")
      .send({ publicKey: await exportJWK(rsa.publicKey) })
      .expect(400);
    const notOnCurve = { ...(await exportJWK((await generateKeyPair("ES256")).publicKey)), y: "A".repeat(43) };
    const invalid = await agent().post("/api/connectors/pairing").send({ publicKey: notOnCurve }).expect(400);

    expect(invalid.body.code).toBe("INVALID_PUBLIC_KEY");
    expect(await db.select().from(schema.connectorPairing)).toHaveLength(0);
  });

  it("requires connector:create, which owners can grant through a custom role", async () => {
    const { owner, organizationId } = await activeOwner();
    const member = await addMember(owner, organizationId);
    const pairing = (await startPairing(await newMachine(), "Poste").expect(200)).body;

    await approve(member.agent, { userCode: pairing.userCode, organizationId }).expect(403);
    await member.agent.get("/api/account/organization/connectors").expect(403);
    expect((await member.agent.get("/api/account/connectors/organizations").expect(200)).body.organizations).toEqual(
      [],
    );
    await agent()
      .post("/api/account/connectors/pairing/approve")
      .send({ userCode: pairing.userCode, organizationId })
      .expect(401);

    await owner
      .post("/api/auth/organization/create-role")
      .send({ organizationId, role: "installer", permission: { connector: ["create"] } })
      .expect(200);
    await owner
      .post("/api/auth/organization/update-member-role")
      .send({ organizationId, memberId: member.memberId, role: "installer" })
      .expect(200);

    await approve(member.agent, { userCode: pairing.userCode, organizationId }).expect(200);
    expect((await poll(pairing.deviceCode).expect(200)).body.clientId).toMatch(/^connector-/);
    const list = await member.agent.get("/api/account/organization/connectors").expect(200);

    expect(list.body.connectors).toHaveLength(1);
    const [connector] = list.body.connectors;

    await member.agent
      .patch(`/api/account/organization/connectors/${connector.id}`)
      .send({ name: "Renamed" })
      .expect(403);
    await member.agent.delete(`/api/account/organization/connectors/${connector.id}`).expect(403);
  });

  it("refuses pairing for an organization without the Data hub", async () => {
    const { owner, organizationId } = await activeOwner(["app"]);
    const pairing = (await startPairing(await newMachine()).expect(200)).body;

    expect((await owner.get("/api/account/connectors/organizations").expect(200)).body.organizations).toEqual([
      expect.objectContaining({ id: organizationId, apps: ["app"] }),
    ]);
    const res = await approve(owner, { userCode: pairing.userCode, organizationId, name: "Nope" }).expect(400);

    expect(res.body.code).toBe("APP_NOT_ENABLED");
  });

  it("pairs a printing station for AGO with a print-only token", async () => {
    const { owner, organizationId } = await activeOwner();
    const machine = await newMachine();
    const pairing = (await startPairing(machine, "Imprimante atelier", "impression").expect(200)).body;
    const preview = await owner.get("/api/account/connectors/pairing").query({ code: pairing.userCode }).expect(200);

    expect(preview.body.pairing).toMatchObject({ kind: "impression", app: "app" });
    await approve(owner, { userCode: pairing.userCode, organizationId }).expect(200);
    const credentials = (await poll(pairing.deviceCode).expect(200)).body;

    expect(credentials.resource).toBe(APP);
    const [connector] = await db.select().from(schema.connector);

    expect(connector).toMatchObject({ kind: "impression", name: "Imprimante atelier" });

    const tokenRes = await requestToken(await clientAssertion(credentials.clientId, machine.privateKey), APP);

    expect(tokenRes.status, JSON.stringify(tokenRes.body)).toBe(200);
    const payload = await verifyJwt(tokenRes.body.access_token, APP);

    expect(payload[ACCESS_CLAIM]).toEqual({ [organizationId]: ["print"] });
    expect(payload.scope).toBe("print");

    const forDatahub = await requestToken(await clientAssertion(credentials.clientId, machine.privateKey), DATAHUB);

    expect(forDatahub.status).toBe(400);
    expect(forDatahub.body.error).toBe("invalid_target");
    expect(await auditActions()).toContain("connector.paired");
  });

  it("refuses a printing station for an organization without AGO", async () => {
    const { owner, organizationId } = await activeOwner(["datahub"]);
    const pairing = (await startPairing(await newMachine(), "Imprimante", "impression").expect(200)).body;
    const res = await approve(owner, { userCode: pairing.userCode, organizationId }).expect(400);

    expect(res.body.code).toBe("APP_NOT_ENABLED");
  });

  it("refuses an unknown connector kind", async () => {
    const res = await startPairing(await newMachine(), "Balance", "scale");

    expect(res.status).toBe(400);
  });
});

describe("connector tokens", () => {
  beforeEach(resetDb);

  it("refuses a replayed client assertion", async () => {
    const { owner, organizationId } = await activeOwner();
    const { machine, clientId } = await pairConnector(owner, organizationId);
    const assertion = await clientAssertion(clientId, machine.privateKey);

    await requestToken(assertion).expect(200);
    const replay = await requestToken(assertion);

    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.body.error).toBe("invalid_client");
    expect(replay.body.access_token).toBeUndefined();
  });

  it("refuses an assertion signed with another key", async () => {
    const { owner, organizationId } = await activeOwner();
    const { clientId } = await pairConnector(owner, organizationId);
    const intruder = await newMachine();
    const res = await requestToken(await clientAssertion(clientId, intruder.privateKey));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toBe("invalid_client");
  });

  it("only issues tokens for the Data hub resource", async () => {
    const { owner, organizationId } = await activeOwner();
    const { machine, clientId } = await pairConnector(owner, organizationId);

    const forApp = await requestToken(await clientAssertion(clientId, machine.privateKey), APP).expect(400);

    expect(forApp.body.error).toBe("invalid_target");
    const withoutResource = await requestToken(await clientAssertion(clientId, machine.privateKey), null).expect(400);

    expect(withoutResource.body.error).toBe("invalid_target");
    const broader = await agent()
      .post("/api/auth/oauth2/token")
      .type("form")
      .send({
        grant_type: "client_credentials",
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: await clientAssertion(clientId, machine.privateKey),
        resource: DATAHUB,
        scope: "openid email",
      })
      .expect(400);

    expect(broader.body.error).toBe("invalid_scope");
  });

  it("stops issuing tokens once the connector is revoked", async () => {
    const { owner, organizationId } = await activeOwner();
    const { machine, clientId, connectorId } = await pairConnector(owner, organizationId);

    await owner.delete(`/api/account/organization/connectors/${connectorId}`).expect(200);
    const res = await requestToken(await clientAssertion(clientId, machine.privateKey));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.access_token).toBeUndefined();
    const list = await owner.get("/api/account/organization/connectors").expect(200);

    expect(list.body.connectors[0]).toMatchObject({ id: connectorId, status: "revoked" });
    expect(await db.select().from(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId))).toHaveLength(0);
    await owner.delete(`/api/account/organization/connectors/${connectorId}`).expect(409);
    expect(await auditActions()).toContain("connector.revoked");
  });

  it("stops issuing tokens when the organization loses the Data hub", async () => {
    const { owner, organizationId, adminAgent } = await activeOwner();
    const { machine, clientId } = await pairConnector(owner, organizationId);

    await adminAgent
      .patch(`/api/admin/organizations/${organizationId}`)
      .send({ apps: ["app"] })
      .expect(200);
    const res = await requestToken(await clientAssertion(clientId, machine.privateKey));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("access_denied");
  });

  it("removes connector clients when the organization is deleted", async () => {
    const { owner, organizationId, adminAgent } = await activeOwner();
    const { machine, clientId } = await pairConnector(owner, organizationId);
    const [org] = await db.select().from(schema.organization).where(eq(schema.organization.id, organizationId));

    await adminAgent.delete(`/api/admin/organizations/${organizationId}`).send({ confirm: org!.slug }).expect(200);
    expect(await db.select().from(schema.connector)).toHaveLength(0);
    expect(await db.select().from(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId))).toHaveLength(0);
    const res = await requestToken(await clientAssertion(clientId, machine.privateKey));

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("connector management", () => {
  beforeEach(resetDb);

  it("lists, renames and audits connectors of the active organization", async () => {
    const { owner, organizationId } = await activeOwner();
    const { connectorId, clientId } = await pairConnector(owner, organizationId, "Serveur");

    await owner.patch(`/api/account/organization/connectors/${connectorId}`).send({ name: "Serveur Lyon" }).expect(200);
    const list = await owner.get("/api/account/organization/connectors").expect(200);

    expect(list.body).toMatchObject({ total: 1, active: 1 });
    expect(list.body.connectors[0]).toMatchObject({
      id: connectorId,
      name: "Serveur Lyon",
      clientId,
      status: "active",
      lastUsedAt: null,
      createdBy: { name: "Invited" },
    });
    const [client] = await db.select().from(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId));

    expect(client!.name).toBe("Serveur Lyon");
    const [renamed] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "connector.renamed"));

    expect(renamed).toMatchObject({
      organizationId,
      targetId: connectorId,
      metadata: { from: "Serveur", to: "Serveur Lyon" },
    });
    await owner.patch(`/api/account/organization/connectors/unknown`).send({ name: "X" }).expect(404);
  });

  it("does not expose connectors of another organization", async () => {
    const first = await activeOwner();
    const second = await activeOwner();
    const { connectorId } = await pairConnector(first.owner, first.organizationId);

    expect((await second.owner.get("/api/account/organization/connectors").expect(200)).body.connectors).toEqual([]);
    await second.owner.delete(`/api/account/organization/connectors/${connectorId}`).expect(404);
    const res = await approve(second.owner, {
      userCode: "BCDF-GHJK",
      organizationId: first.organizationId,
      name: "Cross",
    });

    expect(res.status).toBe(403);
  });

  it("lets global admins list and revoke connectors of any organization", async () => {
    const { owner, organizationId, adminAgent } = await activeOwner();
    const { connectorId } = await pairConnector(owner, organizationId);

    const list = await adminAgent.get(`/api/admin/organizations/${organizationId}/connectors`).expect(200);

    expect(list.body.connectors).toHaveLength(1);
    await owner.get(`/api/admin/organizations/${organizationId}/connectors`).expect(403);
    await adminAgent.delete(`/api/admin/organizations/${organizationId}/connectors/${connectorId}`).expect(200);
    const [connector] = await db.select().from(schema.connector);

    expect(connector!.revokedAt).toBeInstanceOf(Date);
  });
});

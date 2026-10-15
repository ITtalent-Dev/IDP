import { beforeEach, describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { agent, PASSWORD, resetDb, setupOrgWithOwner, type Agent } from "./helpers/index";
import { authorize, exchangeCode, seedTestClients } from "./helpers/oauth";

const DATAHUB = process.env.DATAHUB_RESOURCE!;
const WITHOUT_OFFLINE = "openid profile email";

type Clients = Awaited<ReturnType<typeof seedTestClients>>;

async function tokens(clients: Clients, user: Agent, scope?: string) {
  const auth = await authorize(user, clients.datahub, scope ? { scope } : {});

  expect(auth.code, `authorize did not return a code: ${auth.status} ${auth.location}`).toBeDefined();

  return exchangeCode(clients.datahub, { code: auth.code!, verifier: auth.verifier, redirectUri: auth.redirectUri });
}

function refresh(clients: Clients, refreshToken: string) {
  return agent()
    .post("/api/auth/oauth2/token")
    .auth(clients.datahub.clientId, clients.datahub.clientSecret)
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: refreshToken, resource: DATAHUB });
}

describe("offline_access scope", () => {
  beforeEach(resetDb);

  it("accepts a client requesting no offline_access without extra consent", async () => {
    const clients = await seedTestClients();
    const { owner } = await setupOrgWithOwner(["datahub"]);
    const auth = await authorize(owner, clients.datahub, { scope: WITHOUT_OFFLINE });

    expect(auth.status).toBe(302);
    expect(auth.code).toBeDefined();
  });

  it("returns no refresh token without offline_access", async () => {
    const clients = await seedTestClients();
    const { owner } = await setupOrgWithOwner(["datahub"]);
    const res = await tokens(clients, owner, WITHOUT_OFFLINE);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.access_token).toBeDefined();
    expect(res.body.refresh_token).toBeUndefined();
    expect(res.body.scope).not.toContain("offline_access");
  });

  it("returns a refresh token with offline_access that ends with its session on sign-out", async () => {
    const clients = await seedTestClients();
    const { owner } = await setupOrgWithOwner(["datahub"]);
    const res = await tokens(clients, owner);

    expect(typeof res.body.refresh_token).toBe("string");
    await owner.post("/api/auth/sign-out").send({}).expect(200);

    const revoked = await refresh(clients, res.body.refresh_token);

    expect(revoked.status, JSON.stringify(revoked.body)).toBe(400);
    expect(revoked.body.error).toBe("invalid_grant");
  });

  it("issues tokens for the new account after an account switch on the auth-service", async () => {
    const clients = await seedTestClients();
    const a = await setupOrgWithOwner(["datahub"]);
    const b = await setupOrgWithOwner(["datahub"]);
    const user = a.owner;
    const first = await tokens(clients, user, WITHOUT_OFFLINE);
    const subA = decodeJwt(first.body.access_token).sub;

    await user.post("/api/auth/sign-out").send({}).expect(200);
    await user.post("/api/auth/sign-in/email").send({ email: b.ownerEmail, password: PASSWORD }).expect(200);

    const second = await tokens(clients, user, WITHOUT_OFFLINE);
    const subB = decodeJwt(second.body.access_token).sub;

    expect(subB).toBeDefined();
    expect(subB).not.toBe(subA);
  });
});

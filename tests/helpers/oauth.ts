import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { expect } from "vitest";
import { seedClients, type SeededClient } from "../../server/lib/oauth/clients";
import { PLATFORM } from "../../server/lib/apps";
import { agent, type Agent } from "./index";

export const ISSUER = `${process.env.AUTH_BASE_URL}/api/auth`;

export async function seedTestClients(): Promise<{ platform: SeededClient & { clientSecret: string } }> {
  const platform = await seedClients({ rotateSecrets: true });

  return { platform: platform as SeededClient & { clientSecret: string } };
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export interface AuthorizeResult {
  status: number;
  location: string;
  code?: string;
}

export async function authorize(
  user: Agent,
  client: SeededClient,
  opts: { resource?: string | string[]; scope?: string; redirectUri?: string; prompt?: string } = {},
) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const redirectUri = opts.redirectUri ?? PLATFORM.redirectUris[0]!;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    scope: opts.scope ?? "openid profile email offline_access",
    state: b64url(randomBytes(8)),
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  if (opts.prompt) params.set("prompt", opts.prompt);
  const resources = opts.resource === undefined ? [client.resource] : [opts.resource].flat();

  for (const r of resources) params.append("resource", r);

  const res = await user.get(`/api/auth/oauth2/authorize?${params}`);
  const location: string = res.headers.location ?? res.body?.url ?? "";
  const code = location.startsWith(redirectUri) ? (new URL(location).searchParams.get("code") ?? undefined) : undefined;

  return { status: res.status, location, code, verifier, redirectUri };
}

export async function exchangeCode(
  client: SeededClient & { clientSecret: string },
  grant: { code: string; verifier: string; redirectUri: string; resource?: string },
) {
  return agent()
    .post("/api/auth/oauth2/token")
    .auth(client.clientId, client.clientSecret)
    .type("form")
    .send({
      grant_type: "authorization_code",
      code: grant.code,
      code_verifier: grant.verifier,
      redirect_uri: grant.redirectUri,
      resource: grant.resource ?? client.resource,
    });
}

export async function getAccessToken(user: Agent, client: SeededClient & { clientSecret: string }) {
  const auth = await authorize(user, client);

  expect(auth.code, `authorize did not return a code: ${auth.status} ${auth.location}`).toBeDefined();
  const res = await exchangeCode(client, { code: auth.code!, verifier: auth.verifier, redirectUri: auth.redirectUri });

  return res;
}

export async function verifyJwt(token: string, audience: string): Promise<JWTPayload> {
  const jwks = (await agent().get("/api/auth/jwks").expect(200)).body;
  const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), { issuer: ISSUER, audience });

  return payload;
}

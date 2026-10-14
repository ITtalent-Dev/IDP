import { randomBytes } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { auth } from "../auth";
import { APPS } from "../apps";
import { db, schema } from "../db/index";
import { APP_IDS, type AppId } from "../../../shared/permissions";
import { runAsSystem } from "../support/system-context";

export const SYSTEM_USER_EMAIL = "system@auth-service.internal";
const softwareId = (appId: AppId) => `auth-service:${appId}`;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const applicationTypeFor = (redirectUris: string[]): "web" | "native" =>
  redirectUris.some((u) => {
    const url = new URL(u);

    return url.protocol === "http:" && LOOPBACK.has(url.hostname);
  })
    ? "native"
    : "web";

export interface SeededClient {
  appId: AppId;
  clientId: string;
  clientSecret?: string;
  created: boolean;
  resource: string;
}

async function withSystemAdminSession<T>(fn: (headers: Headers) => Promise<T>): Promise<T> {
  const ctx = await auth.$context;
  const password = randomBytes(32).toString("base64url");
  let [system] = await db.select().from(schema.user).where(eq(schema.user.email, SYSTEM_USER_EMAIL)).limit(1);

  if (!system) {
    const created = await runAsSystem(() =>
      auth.api.signUpEmail({ body: { email: SYSTEM_USER_EMAIL, password, name: "System" } }),
    );

    [system] = await db.select().from(schema.user).where(eq(schema.user.id, created.user.id));
  } else {
    const hash = await hashPassword(password);
    const [credential] = await db
      .select()
      .from(schema.account)
      .where(and(eq(schema.account.userId, system.id), eq(schema.account.providerId, "credential")));

    if (credential) await ctx.internalAdapter.updatePassword(system.id, hash);
    else {
      await ctx.internalAdapter.linkAccount({
        userId: system.id,
        providerId: "credential",
        accountId: system.id,
        password: hash,
      });
    }
  }

  await db
    .update(schema.user)
    .set({ role: "admin", emailVerified: true, banned: false })
    .where(eq(schema.user.id, system!.id));

  const signIn = await auth.api.signInEmail({
    body: { email: SYSTEM_USER_EMAIL, password },
    returnHeaders: true,
  });
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

  try {
    return await fn(new Headers({ cookie }));
  } finally {
    await db.delete(schema.session).where(eq(schema.session.userId, system!.id));
    await db
      .update(schema.account)
      .set({ password: null })
      .where(and(eq(schema.account.userId, system!.id), eq(schema.account.providerId, "credential")));
  }
}

async function linkOnlyResource(clientId: string, resource: string) {
  await db
    .delete(schema.oauthClientResource)
    .where(and(eq(schema.oauthClientResource.clientId, clientId), ne(schema.oauthClientResource.resourceId, resource)));
  await db
    .insert(schema.oauthClientResource)
    .values({ id: crypto.randomUUID(), clientId, resourceId: resource, createdAt: new Date() })
    .onConflictDoNothing();
}

export async function clientExists(clientId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.oauthClient.id })
    .from(schema.oauthClient)
    .where(eq(schema.oauthClient.clientId, clientId))
    .limit(1);

  return Boolean(row);
}

export async function seedClients(opts: { rotateSecrets?: boolean; apps?: AppId[] } = {}): Promise<SeededClient[]> {
  await auth.$context;

  return withSystemAdminSession(async (headers) => {
    const results: SeededClient[] = [];

    for (const appId of opts.apps ?? APP_IDS) {
      const app = APPS[appId];
      const [existing] = await db
        .select()
        .from(schema.oauthClient)
        .where(eq(schema.oauthClient.softwareId, softwareId(appId)))
        .limit(1);

      const common = {
        client_name: app.label,
        client_uri: app.url,
        redirect_uris: app.redirectUris,
        post_logout_redirect_uris: [app.url],
        scope: "openid profile email offline_access",
        grant_types: ["authorization_code", "refresh_token"],
        skip_consent: true,
        enable_end_session: true,
      };

      let clientId: string;
      let clientSecret: string | undefined;

      if (!existing) {
        const created = await auth.api.adminCreateOAuthClient({
          headers,
          body: {
            ...common,
            software_id: softwareId(appId),
            application_type: applicationTypeFor(app.redirectUris),
            token_endpoint_auth_method: "client_secret_basic",
          },
        });

        clientId = created.client_id;
        clientSecret = created.client_secret;
      } else {
        clientId = existing.clientId;
        await auth.api.adminUpdateOAuthClient({ headers, body: { client_id: clientId, update: common } });
        if (opts.rotateSecrets) {
          const rotated = await auth.api.rotateClientSecret({ headers, body: { client_id: clientId } });

          clientSecret = rotated.client_secret;
        }
      }

      await linkOnlyResource(clientId, app.resource);
      results.push({ appId, clientId, clientSecret, created: !existing, resource: app.resource });
    }

    return results;
  });
}

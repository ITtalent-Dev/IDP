import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import {
  admin,
  genericOAuth,
  haveIBeenPwned,
  jwt,
  lastLoginMethod,
  magicLink,
  openAPI,
  organization,
  twoFactor,
} from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { db, schema } from "./db/index";
import { env } from "./env";
import { sendEmailInBackground } from "./email/mailer";
import { magicLinkTemplate, resetPasswordTemplate, verifyEmailTemplate } from "./email/templates";
import { recordActivity } from "./account-lifecycle";
import { logger } from "./support/logger";
import { ac, roles, APP_IDS } from "../../shared/permissions";
import { AUTHENTIK_PROVIDER_ID, assertSignupAllowed, isAuthentikCallback } from "./auth/signup-guard";
import { revokeOnPasswordReset, revokeOnSessionDelete } from "./auth/token-revocation";
import { afterHook, beforeHook } from "./auth/hooks";
import { endUserSessionsPlugin } from "./auth/end-user-sessions-plugin";
import { impersonationClaim } from "./auth/impersonation";
import { twoFactorTokenGuard } from "./auth/two-factor-policy";
import { authentikUserInfo } from "./auth/authentik";
import { alertOnTwoFactorChange, notifyPasswordChanged } from "./auth/security-alerts";
import { auditTwoFactorChange } from "./auth/security-audit";
import { INVITATION_TTL_SECONDS, sendInvitation } from "./auth/invitations";
import { buildAccessTokenClaims } from "./auth/access-claims";
import { CONNECTOR_SCOPE } from "./connectors/connectors";
import { APPS } from "./apps";
import { hasGlobalRole } from "./support/roles";
import { needsOrganizationSelection, organizationSelectionField } from "./auth/org-selection";

const secureCookies = env.AUTH_BASE_URL.startsWith("https://");

export const ISSUER = `${env.AUTH_BASE_URL}/api/auth`;
const generatingSchema = process.env.AUTH_SCHEMA_GENERATION === "1";
const isAdminUser = ({ user }: { user?: Record<string, unknown> }) =>
  hasGlobalRole(typeof user?.role === "string" ? user.role : null, "admin");

export const auth = betterAuth({
  appName: "Auth",
  baseURL: env.AUTH_BASE_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  trustedOrigins: [env.AUTH_BASE_URL, env.DATAHUB_URL, env.APP_URL],
  disabledPaths: ["/token", "/admin/remove-user", "/delete-user", "/delete-user/callback"],

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 10,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, url }) => {
      sendEmailInBackground(user.email, resetPasswordTemplate(url));
    },
    onPasswordReset: async ({ user }) => {
      await revokeOnPasswordReset(user.id);
      notifyPasswordChanged(user.email);
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24,
    sendVerificationEmail: async ({ user, url }) => {
      sendEmailInBackground(user.email, verifyEmailTemplate(url));
    },
  },

  socialProviders: {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            prompt: "select_account" as const,
          },
        }
      : {}),
    ...(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
      ? {
          microsoft: {
            clientId: env.MICROSOFT_CLIENT_ID,
            clientSecret: env.MICROSOFT_CLIENT_SECRET,
            tenantId: env.MICROSOFT_TENANT_ID,
            prompt: "select_account" as const,
            disableProfilePhoto: true,
          },
        }
      : {}),
  },

  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
      allowDifferentEmails: false,
    },
  },

  user: {
    additionalFields: {
      hasPasskey: { type: "boolean", input: false, required: false, defaultValue: false },
      lastActiveAt: { type: "date", input: false, required: false },
      inactivityWarnedAt: { type: "date", input: false, required: false },
      deletedAt: { type: "date", input: false, required: false },
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    additionalFields: organizationSelectionField,
  },

  databaseHooks: {
    session: {
      create: {
        after: async (session) => recordActivity(session as { userId: string; impersonatedBy?: string | null }),
      },
      delete: {
        before: async (session, ctx) => {
          await revokeOnSessionDelete(session, ctx);
        },
      },
    },
    user: {
      update: {
        after: async (user, ctx) => {
          const changed = user as { id: string; email: string; twoFactorEnabled?: boolean | null };

          alertOnTwoFactorChange(changed, ctx?.path);
          await auditTwoFactorChange(changed, ctx as never);
        },
      },
      create: {
        before: async (user, ctx) => {
          await assertSignupAllowed(user, ctx);

          return { data: isAuthentikCallback(ctx) ? { ...user, role: "admin", emailVerified: true } : user };
        },
      },
    },
  },

  hooks: {
    before: beforeHook,
    after: afterHook,
  },

  rateLimit: {
    enabled: env.RATE_LIMIT_ENABLED,
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 5 },
      "/sign-in/magic-link": { window: 60, max: 3 },
      "/magic-link/verify": { window: 60, max: 10 },
      "/request-password-reset": { window: 60, max: 3 },
      "/send-verification-email": { window: 60, max: 3 },
      "/organization/invite-member": { window: 60, max: 10 },
      "/organization/accept-invitation": { window: 60, max: 10 },
      "/two-factor/verify-totp": { window: 60, max: 10 },
      "/two-factor/verify-backup-code": { window: 60, max: 10 },
      "/passkey/verify-authentication": { window: 60, max: 10 },
    },
  },

  advanced: {
    useSecureCookies: secureCookies,
    defaultCookieAttributes: {
      httpOnly: true,
      secure: secureCookies,
      sameSite: "lax",
    },
    ipAddress: {
      ipAddressHeaders: [env.TRUSTED_IP_HEADER],
    },
  },

  logger: {
    level: env.LOG_LEVEL === "debug" ? "debug" : "warn",
    log: (level, message) => {
      logger[level]("better-auth: " + message);
    },
  },

  plugins: [
    endUserSessionsPlugin(),
    magicLink({
      expiresIn: 60 * 5,
      storeToken: "hashed",
      sendMagicLink: async ({ email, url }) => {
        sendEmailInBackground(email, magicLinkTemplate(url));
      },
    }),
    organization({
      ac,
      roles,
      dynamicAccessControl: { enabled: true, maximumRolesPerOrganization: 50 },
      allowUserToCreateOrganization: false,
      requireEmailVerificationOnInvitation: true,
      invitationExpiresIn: INVITATION_TTL_SECONDS,
      schema: {
        organization: {
          additionalFields: {
            apps: { type: "string[]", input: false, required: false, defaultValue: [] },
            requireTwoFactor: { type: "boolean", input: true, required: false, defaultValue: false },
          },
        },
      },
      sendInvitationEmail: async (data) => {
        sendInvitation({
          invitationId: data.id,
          email: data.email,
          organizationName: data.organization.name,
          inviterName: data.inviter.user.name || data.inviter.user.email,
        });
      },
    }),
    admin({
      defaultRole: "user",
      adminRoles: ["admin"],
      impersonationSessionDuration: 60 * 60,
    }),
    ...(env.AUTHENTIK_ISSUER && env.AUTHENTIK_CLIENT_ID && env.AUTHENTIK_CLIENT_SECRET
      ? [
          genericOAuth({
            config: [
              {
                providerId: AUTHENTIK_PROVIDER_ID,
                discoveryUrl: `${env.AUTHENTIK_ISSUER}/.well-known/openid-configuration`,
                clientId: env.AUTHENTIK_CLIENT_ID,
                clientSecret: env.AUTHENTIK_CLIENT_SECRET,
                scopes: ["openid", "email", "profile"],
                pkce: true,
                overrideUserInfo: true,
                getUserInfo: authentikUserInfo,
              },
            ],
          }),
        ]
      : []),
    jwt({
      disableSettingJwtHeader: true,
      jwt: { issuer: ISSUER },
      jwks: { keyPairConfig: { alg: "ES256" } },
    }),
    oauthProvider({
      loginPage: "/sign-in",
      consentPage: "/consent",
      scopes: ["openid", "profile", "email", "offline_access", CONNECTOR_SCOPE],
      resources: generatingSchema
        ? undefined
        : APP_IDS.map((id) => ({ identifier: APPS[id].resource, name: APPS[id].label })),
      resourceSeedMode: "merge",
      enforcePerClientResources: true,
      accessTokenExpiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      m2mAccessTokenExpiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      allowDynamicClientRegistration: false,
      clientPrivileges: isAdminUser,
      resourcePrivileges: isAdminUser,
      customAccessTokenClaims: buildAccessTokenClaims,
      selectAccount: {
        page: "/select-organization",
        shouldRedirect: () => false,
      },
      postLogin: {
        page: "/select-organization",
        shouldRedirect: needsOrganizationSelection,
        consentReferenceId: ({ session }) =>
          (session as { activeOrganizationId?: string | null }).activeOrganizationId ?? undefined,
      },
    }),
    impersonationClaim(),
    twoFactor({
      issuer: "Auth",
      allowPasswordless: true,
      trustDeviceMaxAge: 60 * 60 * 24 * 30,
    }),
    twoFactorTokenGuard(),
    haveIBeenPwned(),
    openAPI({ path: "/reference" }),
    lastLoginMethod({
      customResolveMethod: (ctx) => (ctx.path?.startsWith("/two-factor/verify-") ? "email" : null),
    }),
    passkey({
      rpID: new URL(env.AUTH_BASE_URL).hostname,
      rpName: "Auth",
      origin: env.AUTH_BASE_URL,
      authenticatorSelection: { userVerification: "required", residentKey: "required" },
    }),
  ],
});

export type Auth = typeof auth;

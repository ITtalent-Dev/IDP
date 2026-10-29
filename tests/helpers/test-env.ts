export const TEST_PORT = 3100;

export const TEST_BASE_URL = `http://localhost:${TEST_PORT}`;

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  PORT: String(TEST_PORT),
  AUTH_BASE_URL: TEST_BASE_URL,
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123456",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://auth:auth@localhost:5435/auth_test",
  DATAHUB_URL: "http://localhost:4001",
  AGO_URL: "http://localhost:4002",
  DATAHUB_RESOURCE: "https://datahub.test",
  AGO_RESOURCE: "https://app.test",
  DATAHUB_REDIRECT_URIS: "http://localhost:4001/auth/callback",
  AGO_REDIRECT_URIS: "http://localhost:4002/auth/callback",
  DATAHUB_BACKCHANNEL_LOGOUT_URI: "http://127.0.0.1:4901/auth/backchannel-logout",
  CLAIMS_NAMESPACE: "https://mondomaine.fr",
  SMTP_HOST: "localhost",
  SMTP_PORT: process.env.TEST_SMTP_PORT ?? "1025",
  MAILPIT_URL: process.env.TEST_MAILPIT_URL ?? "http://localhost:8025",
  RATE_LIMIT_ENABLED: "false",
  RETENTION_ENABLED: "false",
  AUTHENTIK_ISSUER: "https://authentik.test/application/o/auth",
  AUTHENTIK_CLIENT_ID: "authentik-client",
  AUTHENTIK_CLIENT_SECRET: "authentik-secret",
  AUTHENTIK_REQUIRE_MFA: "true",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
};

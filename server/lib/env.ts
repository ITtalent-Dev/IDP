import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const url = z.url().transform((v) => v.replace(/\/+$/, ""));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  AUTH_BASE_URL: url,
  BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),

  DATABASE_URL: z.string().min(1),

  DATAHUB_URL: url,
  AGO_URL: url,
  DATAHUB_RESOURCE: url,
  AGO_RESOURCE: url,
  DATAHUB_REDIRECT_URIS: z.string().min(1),
  AGO_REDIRECT_URIS: z.string().min(1),
  DATAHUB_BACKCHANNEL_LOGOUT_URI: z.url().optional(),
  AGO_BACKCHANNEL_LOGOUT_URI: z.url().optional(),

  CLAIMS_NAMESPACE: url.default("https://mondomaine.fr"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().min(1).default("Auth <no-reply@mondomaine.fr>"),

  AUTHENTIK_ISSUER: url.optional(),
  AUTHENTIK_CLIENT_ID: z.string().optional(),
  AUTHENTIK_CLIENT_SECRET: z.string().optional(),
  AUTHENTIK_REQUIRE_MFA: bool.default(true),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().default("organizations"),

  RATE_LIMIT_ENABLED: bool.default(true),
  TRUSTED_IP_HEADER: z.string().default("x-forwarded-for"),

  MIGRATE_ON_START: bool.default(false),
  RETENTION_ENABLED: bool.default(true),
  MIGRATIONS_DIR: z.string().default("server/lib/db/migrations"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = EnvSchema.safeParse(raw);

  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");

    console.error(`Invalid configuration:\n${details}`);
    throw new Error("Invalid environment configuration");
  }

  return parsed.data;
}

export const env = loadEnv();

export const splitList = (value: string) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

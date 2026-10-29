import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { auth } from "../../server/lib/auth";
import { db, schema } from "../../server/lib/db/index";
import { runAsSystem } from "../../server/lib/support/system-context";
import { TEST_BASE_URL } from "./test-env";

export const ORIGIN = TEST_BASE_URL;

export const PASSWORD = "a-strong-password";
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

export function agent() {
  const a = request.agent(TEST_BASE_URL);

  a.set("Origin", ORIGIN);

  return a;
}

export type Agent = ReturnType<typeof agent>;

export async function resetDb() {
  const rows = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename not in ('oauth_resource', 'jwks')`,
  );
  const tables = rows.rows.map((r) => `"public"."${r.tablename}"`);

  if (tables.length) await db.execute(sql.raw(`truncate ${tables.join(", ")} cascade`));
}

export function uniqueEmail(prefix = "user") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

interface MailpitSummary {
  ID: string;
  Subject: string;
  Created: string;
}

export async function waitForEmail(
  to: string,
  opts: { subject?: RegExp; timeoutMs?: number } = {},
): Promise<{ subject: string; text: string }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 8000);

  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=20`);
    const body = (await res.json()) as { messages: MailpitSummary[] };
    const match = body.messages.find((m) => !opts.subject || opts.subject.test(m.Subject));

    if (match) {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${match.ID}`)).json()) as {
        Subject: string;
        Text: string;
      };

      return { subject: full.Subject, text: full.Text };
    }

    await new Promise((r) => setTimeout(r, 150));
  }

  throw new Error(`No email received for ${to}`);
}

export async function countEmails(to: string, subject: RegExp, settleMs = 700): Promise<number> {
  await new Promise((r) => setTimeout(r, settleMs));
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=50`);
  const body = (await res.json()) as { messages: MailpitSummary[] };

  return body.messages.filter((m) => subject.test(m.Subject)).length;
}

export function extractLink(text: string): { url: URL; path: string } {
  const m = text.match(/https?:\/\/\S+/);

  if (!m) throw new Error("No link found in email");
  const url = new URL(m[0]);

  return { url, path: url.pathname + url.search };
}

export async function createUser(opts: { email?: string; role?: string; name?: string } = {}) {
  const email = opts.email ?? uniqueEmail(opts.role ?? "user");
  const res = await runAsSystem(() =>
    auth.api.signUpEmail({ body: { email, password: PASSWORD, name: opts.name ?? "Test User" } }),
  );

  await db
    .update(schema.user)
    .set({ emailVerified: true, ...(opts.role ? { role: opts.role } : {}) })
    .where(eq(schema.user.id, res.user.id));

  return { id: res.user.id, email };
}

export async function signIn(email: string, password = PASSWORD): Promise<Agent> {
  const a = agent();
  const res = await a.post("/api/auth/sign-in/email").send({ email, password });

  if (res.status !== 200) throw new Error(`Sign-in failed (${res.status}): ${JSON.stringify(res.body)}`);

  return a;
}

export async function signedInAdmin() {
  const admin = await createUser({ role: "admin", name: "Admin" });

  return { admin, agent: await signIn(admin.email) };
}

export async function createOrganization(
  adminAgent: Agent,
  input: { name?: string; slug?: string; apps?: string[]; ownerEmail?: string } = {},
) {
  const slug = input.slug ?? `org-${Math.random().toString(36).slice(2, 8)}`;
  const ownerEmail = input.ownerEmail ?? uniqueEmail("owner");
  const res = await adminAgent.post("/api/admin/organizations").send({
    name: input.name ?? `Org ${slug}`,
    slug,
    apps: input.apps ?? ["datahub", "ago"],
    ownerEmail,
  });

  if (res.status !== 201) throw new Error(`Org creation failed (${res.status}): ${JSON.stringify(res.body)}`);

  return {
    organizationId: res.body.organization.id as string,
    invitationId: res.body.invitationId as string,
    ownerEmail,
  };
}

export async function acceptInvitationAsNewUser(email: string, invitationId: string): Promise<Agent> {
  const a = agent();

  await a.post("/api/auth/sign-up/email").send({ email, password: PASSWORD, name: "Invited" }).expect(200);
  const mail = await waitForEmail(email, { subject: /Confirmez/ });

  await a.get(extractLink(mail.text).path);
  await a.post("/api/auth/organization/accept-invitation").send({ invitationId }).expect(200);

  return a;
}

export async function setupOrgWithOwner(apps: string[] = ["datahub", "ago"]) {
  const { agent: adminAgent, admin } = await signedInAdmin();
  const org = await createOrganization(adminAgent, { apps });
  const owner = await acceptInvitationAsNewUser(org.ownerEmail, org.invitationId);

  return { ...org, owner, adminAgent, admin };
}

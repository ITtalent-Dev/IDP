import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../server/lib/db/index";
import { seedClientsToVault } from "../server/lib/oauth/seed-vault";
import type { VaultConfig } from "../server/lib/oauth/vault";
import { resetDb } from "./helpers/index";

type Stored = Record<string, string>;

let server: Server;
let dir: string;
let config: VaultConfig;
let store: Map<string, { data: Stored; versions: number }>;
let tokens: (string | undefined)[];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vault-"));
  await writeFile(join(dir, "token"), "fake-token\n");
  server = createServer((req, res) => {
    const path = (req.url ?? "").replace(/^\/v1\/secret\/data\//, "");
    const chunks: Buffer[] = [];

    tokens.push(req.headers["x-vault-token"] as string | undefined);
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { data: Stored };
        const previous = store.get(path);

        store.set(path, { data: body.data, versions: (previous?.versions ?? 0) + 1 });
        res.end(JSON.stringify({ data: { version: store.get(path)!.versions } }));

        return;
      }

      const entry = store.get(path);

      if (!entry) {
        res.statusCode = 404;
        res.end(JSON.stringify({ errors: [] }));

        return;
      }

      res.end(JSON.stringify({ data: { data: entry.data } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  config = { addr: `http://127.0.0.1:${port}`, tokenFile: join(dir, "token") };
});

afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  store = new Map();
  tokens = [];
  await resetDb();
});

describe("seed:clients with Vault", () => {
  it("writes the credentials on the first run and does nothing on the second", async () => {
    const first = await seedClientsToVault(config);

    expect(first.map((r) => r.status)).toEqual(["stored", "stored"]);
    expect([...store.keys()].sort()).toEqual(["oidc-clients/ago", "oidc-clients/datahub"]);

    for (const entry of store.values()) {
      expect(entry.data.CLIENT_ID).toBeTruthy();
      expect(entry.data.CLIENT_SECRET).toBeTruthy();
      expect(entry.versions).toBe(1);
    }

    const snapshot = JSON.stringify([...store.entries()]);
    const second = await seedClientsToVault(config);

    expect(second.map((r) => r.status)).toEqual(["already", "already"]);
    expect(JSON.stringify([...store.entries()])).toBe(snapshot);
    expect(tokens.every((t) => t === "fake-token")).toBe(true);
  });

  it("updates the client metadata on a later run without touching the secret", async () => {
    await seedClientsToVault(config);
    const snapshot = JSON.stringify([...store.entries()]);
    const clientId = store.get("oidc-clients/datahub")!.data.CLIENT_ID!;

    await db
      .update(schema.oauthClient)
      .set({ backchannelLogoutUri: null, name: "stale" })
      .where(eq(schema.oauthClient.clientId, clientId));
    await seedClientsToVault(config);
    const [row] = await db.select().from(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId));

    expect(row!.backchannelLogoutUri).toBe(process.env.DATAHUB_BACKCHANNEL_LOGOUT_URI);
    expect(row!.name).not.toBe("stale");
    expect(JSON.stringify([...store.entries()])).toBe(snapshot);
  });

  it("re-issues and overwrites when the Vault client_id is unknown in the database", async () => {
    await seedClientsToVault(config);
    const before = store.get("oidc-clients/datahub")!;

    store.set("oidc-clients/datahub", {
      data: { CLIENT_ID: "unknown-client", CLIENT_SECRET: "stale" },
      versions: before.versions,
    });

    const results = await seedClientsToVault(config);
    const after = store.get("oidc-clients/datahub")!;

    expect(results.map((r) => r.status)).toEqual(["stored", "already"]);
    expect(after.data.CLIENT_ID).not.toBe("unknown-client");
    expect(after.data.CLIENT_SECRET).not.toBe("stale");
    expect(after.versions).toBe(2);
  });

  it("fails when Vault returns an error", async () => {
    await expect(seedClientsToVault({ ...config, addr: "http://127.0.0.1:9" })).rejects.toThrow(/Vault unreachable/);
  });
});

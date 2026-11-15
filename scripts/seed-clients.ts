import { seedClients } from "../server/lib/oauth/clients";
import { seedClientsToVault } from "../server/lib/oauth/seed-vault";
import { vaultConfigFromEnv } from "../server/lib/oauth/vault";
import { auth } from "../server/lib/auth";
import { pool } from "../server/lib/db/index";

const rotateSecrets = process.argv.includes("--rotate-secrets");
const vault = vaultConfigFromEnv();

try {
  if (vault) {
    const r = await seedClientsToVault(vault, { rotateSecrets });

    console.log(`[${r.client}] ${r.status === "stored" ? "stored in Vault" : "already in Vault"}`);
  } else {
    const c = await seedClients({ rotateSecrets });

    console.log(`\n[platform] ${c.created ? "created" : "updated"}`);
    console.log(`  resource      ${c.resource}`);
    console.log(`  client_id     ${c.clientId}`);
    console.log(
      `  client_secret ${c.clientSecret ?? "(unchanged — run `pnpm seed:clients --rotate-secrets` to issue a new one)"}`,
    );

    console.log("\nStore the secret now: it is hashed at rest and cannot be displayed again.");
  }
} catch (error) {
  const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";

  console.error(`seed:clients failed: ${error instanceof Error ? error.message : String(error)}${cause}`);
  process.exitCode = 1;
} finally {
  await auth.$context.catch(() => undefined);
  await pool.end();
}

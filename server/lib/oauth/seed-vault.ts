import { clientExists, seedClients } from "./clients";
import { readClientCredentials, writeClientCredentials, type VaultConfig } from "./vault";

export const PLATFORM_VAULT_KEY = "platform";

export interface VaultSeedResult {
  client: string;
  status: "stored" | "already";
}

export async function seedClientsToVault(
  config: VaultConfig,
  opts: { rotateSecrets?: boolean } = {},
): Promise<VaultSeedResult> {
  const current = await readClientCredentials(config, PLATFORM_VAULT_KEY);
  const complete = Boolean(current.CLIENT_ID && current.CLIENT_SECRET);

  if (complete && !opts.rotateSecrets && (await clientExists(current.CLIENT_ID!))) {
    await seedClients();

    return { client: PLATFORM_VAULT_KEY, status: "already" };
  }

  const client = await seedClients({ rotateSecrets: true });

  if (!client.clientSecret) throw new Error("No client secret was issued for the platform");
  await writeClientCredentials(config, PLATFORM_VAULT_KEY, {
    CLIENT_ID: client.clientId,
    CLIENT_SECRET: client.clientSecret,
  });

  return { client: PLATFORM_VAULT_KEY, status: "stored" };
}

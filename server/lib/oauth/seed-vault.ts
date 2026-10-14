import { APP_IDS, type AppId } from "../../../shared/permissions";
import { clientExists, seedClients } from "./clients";
import { readClientCredentials, writeClientCredentials, type VaultConfig } from "./vault";

export interface VaultSeedResult {
  appId: AppId;
  status: "stored" | "already";
}

export async function seedClientsToVault(
  config: VaultConfig,
  opts: { rotateSecrets?: boolean } = {},
): Promise<VaultSeedResult[]> {
  const results: VaultSeedResult[] = [];

  for (const appId of APP_IDS) {
    const current = await readClientCredentials(config, appId);
    const complete = Boolean(current.CLIENT_ID && current.CLIENT_SECRET);

    if (complete && !opts.rotateSecrets && (await clientExists(current.CLIENT_ID!))) {
      results.push({ appId, status: "already" });
      continue;
    }

    const [client] = await seedClients({ apps: [appId], rotateSecrets: true });

    if (!client?.clientSecret) throw new Error(`No client secret was issued for ${appId}`);
    await writeClientCredentials(config, appId, { CLIENT_ID: client.clientId, CLIENT_SECRET: client.clientSecret });
    results.push({ appId, status: "stored" });
  }

  return results;
}

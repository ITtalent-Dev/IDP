import { readFile } from "node:fs/promises";

export interface VaultConfig {
  addr: string;
  tokenFile: string;
}

export interface ClientCredentials {
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
}

export function vaultConfigFromEnv(source: NodeJS.ProcessEnv = process.env): VaultConfig | undefined {
  const addr = source.VAULT_ADDR?.trim();
  const tokenFile = source.VAULT_TOKEN_FILE?.trim();

  if (!addr || !tokenFile) return undefined;

  return { addr: addr.replace(/\/+$/, ""), tokenFile };
}

async function request(config: VaultConfig, path: string, init: RequestInit = {}) {
  const token = (await readFile(config.tokenFile, "utf8")).trim();
  let response: Response;

  try {
    response = await fetch(`${config.addr}/v1/${path}`, {
      ...init,
      headers: { "X-Vault-Token": token, "Content-Type": "application/json" },
    });
  } catch (error) {
    throw new Error(`Vault unreachable at ${config.addr}`, { cause: error });
  }

  return response;
}

export async function readClientCredentials(config: VaultConfig, appId: string): Promise<ClientCredentials> {
  const response = await request(config, `secret/data/oidc-clients/${appId}`);

  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`Vault read of oidc-clients/${appId} failed with status ${response.status}`);
  const body = (await response.json()) as { data?: { data?: ClientCredentials | null } };

  return body.data?.data ?? {};
}

export async function writeClientCredentials(
  config: VaultConfig,
  appId: string,
  credentials: Required<ClientCredentials>,
): Promise<void> {
  const response = await request(config, `secret/data/oidc-clients/${appId}`, {
    method: "POST",
    body: JSON.stringify({ data: credentials }),
  });

  if (!response.ok) throw new Error(`Vault write of oidc-clients/${appId} failed with status ${response.status}`);
}

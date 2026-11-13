import { env, splitList } from "./env";
import { APP_IDS, APP_LABELS, type AppId } from "../../shared/permissions";

export interface AppConfig {
  id: AppId;
  label: string;
  url: string;
}

export const PLATFORM = {
  label: "Back Office",
  url: env.PLATFORM_URL,
  resource: env.PLATFORM_RESOURCE,
  redirectUris: splitList(env.PLATFORM_REDIRECT_URIS),
  backchannelLogoutUri: env.PLATFORM_BACKCHANNEL_LOGOUT_URI,
};

export const APPS = Object.fromEntries(
  APP_IDS.map((id) => [id, { id, label: APP_LABELS[id], url: PLATFORM.url }]),
) as Record<AppId, AppConfig>;

export const isPlatformResource = (resource: string) => resource === PLATFORM.resource;

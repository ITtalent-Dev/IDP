import { env, splitList } from "./env";
import { APP_IDS, APP_LABELS, type AppId } from "../../shared/permissions";

export interface AppConfig {
  id: AppId;
  label: string;
  url: string;
  resource: string;
  redirectUris: string[];
  backchannelLogoutUri?: string;
}

export const APPS: Record<AppId, AppConfig> = {
  datahub: {
    id: "datahub",
    label: APP_LABELS.datahub,
    url: env.DATAHUB_URL,
    resource: env.DATAHUB_RESOURCE,
    redirectUris: splitList(env.DATAHUB_REDIRECT_URIS),
    backchannelLogoutUri: env.DATAHUB_BACKCHANNEL_LOGOUT_URI,
  },
  ago: {
    id: "ago",
    label: APP_LABELS.ago,
    url: env.AGO_URL,
    resource: env.AGO_RESOURCE,
    redirectUris: splitList(env.AGO_REDIRECT_URIS),
    backchannelLogoutUri: env.AGO_BACKCHANNEL_LOGOUT_URI,
  },
};

export const appByResource = (resource: string): AppConfig | undefined =>
  APP_IDS.map((id) => APPS[id]).find((a) => a.resource === resource);

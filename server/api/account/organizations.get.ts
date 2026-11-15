import { z } from "zod";
import { PLATFORM, isPlatformResource } from "../../lib/apps";
import { organizationsGrantingPlatform, userMemberships } from "../../lib/account-context";

export default defineEventHandler(async (event) => {
  const session = await requireSession(event);
  const { resource } = parseQuery(event, z.object({ resource: z.string().optional() }));

  if (!resource) return { organizations: await userMemberships(session.user.id) };

  if (!isPlatformResource(resource)) throw apiError(400, "UNKNOWN_RESOURCE", "Unknown resource");

  return {
    app: { label: PLATFORM.label },
    organizations: await organizationsGrantingPlatform(session.user.id),
  };
});

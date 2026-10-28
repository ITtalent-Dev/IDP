import { memberDirectoryQuerySchema, memberSummaries, organizationFromAppToken } from "../../lib/member-directory";

export default defineEventHandler(async (event) => {
  const token = getHeader(event, "authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) throw apiError(401, "UNAUTHORIZED", "Bearer token required");

  const organizationId = await organizationFromAppToken(token);

  if (!organizationId) throw apiError(401, "UNAUTHORIZED", "Invalid or expired token");

  const { ids } = parseQuery(event, memberDirectoryQuerySchema);

  return { members: await memberSummaries(organizationId, ids) };
});

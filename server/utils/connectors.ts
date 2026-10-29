import type { H3Event } from "h3";
import type { DecisionFailure } from "../lib/connectors/pairing";
import { canPairConnectors } from "../lib/connectors/eligibility";
import { canManageConnectors, hasOrganizationPermission } from "../lib/account-context";
import type { AuthSession } from "./http";

const PAIRING_FAILURES: Record<DecisionFailure, [number, string]> = {
  PAIRING_NOT_FOUND: [404, "Unknown or expired pairing code"],
  ORGANIZATION_NOT_FOUND: [404, "Organization not found"],
  APP_NOT_ENABLED: [400, "The organization does not have the application of this connector"],
  NAME_REQUIRED: [400, "A connector name is required"],
};

export const pairingDecisionError = (code: DecisionFailure) => {
  const [status, message] = PAIRING_FAILURES[code];

  return apiError(status, code, message);
};

export async function requirePairingPermission(event: H3Event, session: AuthSession, organizationId: string) {
  await enforceRateLimit(event, "connector-pairing-decision", { windowSeconds: 60, max: 20 }, session.user.id);
  if (!(await canPairConnectors(event.headers, organizationId))) {
    throw apiError(403, "FORBIDDEN", "Connector creation permission required");
  }
}

const MANAGEMENT_FAILURES = {
  CONNECTOR_NOT_FOUND: [404, "Connector not found"],
  CONNECTOR_REVOKED: [409, "Connector already revoked"],
} as const;

export const connectorManagementError = (code: keyof typeof MANAGEMENT_FAILURES) => {
  const [status, message] = MANAGEMENT_FAILURES[code];

  return apiError(status, code, message);
};

export async function requireConnectorAccess(event: H3Event, action?: "update" | "delete") {
  const session = await requireSession(event);
  const organizationId = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;

  if (!organizationId) throw apiError(400, "NO_ACTIVE_ORGANIZATION", "No active organization");
  const allowed = action
    ? await hasOrganizationPermission(event.headers, organizationId, { connector: [action] })
    : await canManageConnectors(event.headers, organizationId);

  if (!allowed) throw apiError(403, "FORBIDDEN", "Connector permission required");

  return { session, organizationId };
}

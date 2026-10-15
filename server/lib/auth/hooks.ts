import { createAuthMiddleware } from "better-auth/api";
import { normalizeRolePermissionsInBody } from "./role-permissions";
import { enforceRoleCeiling, forbidCeilingEdits } from "./role-ceiling";
import { stripOfflineAccessWhenImpersonating } from "./impersonation";
import { markOrganizationSelected } from "./org-selection";
import { auditAfterHook } from "./audit-hooks";
import { refuseMagicLinkWithTwoFactor, requirePasskeyUserVerification, syncHasPasskey } from "./two-factor-policy";
import { revokeAfterHook } from "./token-revocation";
import { alertOnNewDevice, alertOnPasswordChange } from "./security-alerts";
import { restrictApiDocsToAdmins } from "./api-docs";
import { validateOrganizationProfile } from "../org-profile";
import { requireResourceForMachineTokens } from "../connectors/token-guard";

export const beforeHook = createAuthMiddleware(async (ctx) => {
  await restrictApiDocsToAdmins(ctx);
  forbidCeilingEdits(ctx);
  validateOrganizationProfile(ctx);
  await enforceRoleCeiling(ctx);
  await refuseMagicLinkWithTwoFactor(ctx);
  requirePasskeyUserVerification(ctx);
  requireResourceForMachineTokens(ctx);

  return normalizeRolePermissionsInBody(ctx) ?? (await stripOfflineAccessWhenImpersonating(ctx));
});

export const afterHook = createAuthMiddleware(async (ctx) => {
  await markOrganizationSelected(ctx);
  await syncHasPasskey(ctx);
  await alertOnNewDevice(ctx);
  await alertOnPasswordChange(ctx);
  await auditAfterHook(ctx);
  await revokeAfterHook(ctx);
});

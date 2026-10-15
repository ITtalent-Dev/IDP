import { randomUUID } from "node:crypto";
import { db, schema } from "../db/index";
import { logger } from "./logger";

export const AUDIT_ACTIONS = [
  "impersonation.start",
  "impersonation.stop",
  "organization.create",
  "organization.update",
  "organization.ceiling.update",
  "organization.security.update",
  "organization.delete",
  "organization.owner.transfer",
  "role.create",
  "role.update",
  "role.delete",
  "invitation.create",
  "member.role.update",
  "member.remove",
  "member.leave",
  "user.ban",
  "user.unban",
  "user.role.update",
  "user.two_factor.reset",
  "user.two_factor.enable",
  "user.two_factor.disable",
  "user.passkey.add",
  "user.passkey.remove",
  "user.delete",
  "user.tokens.revoke",
  "user.export",
  "user.inactivity.kept",
  "archive.export",
  "connector.paired",
  "connector.pairing.denied",
  "connector.renamed",
  "connector.revoked",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  action: AuditAction;
  actorId?: string | null;
  impersonatedBy?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  organizationId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(schema.auditLog).values({
      id: randomUUID(),
      action: entry.action,
      actorId: entry.actorId ?? null,
      impersonatedBy: entry.impersonatedBy ?? null,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      organizationId: entry.organizationId ?? null,
      metadata: entry.metadata ?? {},
    });
  } catch (err) {
    logger.error("audit write failed", { action: entry.action, err });
  }
}

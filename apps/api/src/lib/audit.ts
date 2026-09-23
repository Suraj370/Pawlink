import type { AuditAction } from "@pawlink/shared";
import type { DbClient } from "../db/client.js";
import { auditLogs } from "../db/schema.js";

// The ONLY place any row is ever written to audit_logs — every mutating
// or sensitive-read code path in routes/medical-records.ts calls through
// here rather than inserting directly, so "what counts as an audit event"
// stays in one place. There is deliberately no update/delete counterpart:
// the table is append-only (see docs/architecture.md, "Audit logging").
//
// `metadata` must never carry medical content (see
// docs/architecture.md, "Sensitive data handling") — callers pass small
// operational context only (e.g. which fields changed, not their values).
//
// Accepts either the outer `db` or an open transaction `tx` so a write
// (create/update/archive) can log its audit event as part of the SAME
// transaction as the data change itself — either both commit or neither
// does, which a separate post-commit write could never guarantee.
export async function recordAuditEvent(
  queryable: Pick<DbClient, "insert">,
  event: {
    actorUserId: string;
    action: AuditAction;
    resourceType: string;
    resourceId?: string | null;
    petId?: string | null;
    providerId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  await queryable.insert(auditLogs).values({
    actorUserId: event.actorUserId,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId ?? null,
    petId: event.petId ?? null,
    providerId: event.providerId ?? null,
    metadata: event.metadata ?? null,
  });
}

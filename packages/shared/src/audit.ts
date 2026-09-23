import { z } from "zod";

// Server-generated only — there is no client-facing API that accepts an
// audit action, a resource id, or an actor id (see docs/architecture.md,
// "Audit logging must be server-side"). This enum exists in the shared
// package purely so the API and its tests share one source of truth for
// the legal action values, not because any frontend code constructs them.
export const AUDIT_ACTION_VALUES = [
  "MEDICAL_RECORD_CREATED",
  "MEDICAL_RECORD_VIEWED",
  "MEDICAL_RECORD_UPDATED",
  "MEDICAL_RECORD_ARCHIVED",
  "AUTHORIZATION_DENIED",
] as const;
export const auditActionSchema = z.enum(AUDIT_ACTION_VALUES);
export type AuditAction = z.infer<typeof auditActionSchema>;

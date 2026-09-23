import { z } from "zod";
import { isoOffsetDateTimeSchema } from "./bookings.js";

// A controlled, closed set — never arbitrary client-supplied strings. Kept
// deliberately small and practical (a real hospital-information system
// would have dozens of categories); this is what a first version of a
// pet-care record system needs and no more.
export const MEDICAL_RECORD_TYPE_VALUES = [
  "VISIT",
  "DIAGNOSIS",
  "VACCINATION",
  "MEDICATION",
  "ALLERGY",
  "LAB_RESULT",
  "SURGERY",
  "OTHER",
] as const;
export const medicalRecordTypeSchema = z.enum(MEDICAL_RECORD_TYPE_VALUES);
export type MedicalRecordType = z.infer<typeof medicalRecordTypeSchema>;

// Records are never hard-deleted (see docs/architecture.md, "Medical
// records"). ARCHIVED is the only lifecycle transition away from ACTIVE,
// and it's one-directional through the API (no un-archive endpoint).
export const MEDICAL_RECORD_STATUS_VALUES = ["ACTIVE", "ARCHIVED"] as const;
export const medicalRecordStatusSchema = z.enum(MEDICAL_RECORD_STATUS_VALUES);
export type MedicalRecordStatus = z.infer<typeof medicalRecordStatusSchema>;

function emptyToUndefined(value: unknown) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const optionalTrimmedString = (max: number) =>
  z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

const requiredTrimmedString = (max: number, message: string) => z.string().trim().min(1, message).max(max);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const requiredDateOnly = (message: string) => z.string().regex(DATE_RE, message);
const optionalDateOnly = (message: string) => z.preprocess(emptyToUndefined, requiredDateOnly(message).optional());

// -----------------------------------------------------------------------
// Structured, per-record-type "details" — deliberately NOT one big
// unstructured text blob (see the design note in the milestone brief),
// but also deliberately not a dozen sparse nullable columns on the table:
// each record type gets its own small, strictly-shaped object, stored as
// one JSONB column, validated on the way in AND the way out by the exact
// schema for that record's type (see detailsSchemaForType below). Unknown
// keys are rejected (.strict()) so this can never become a dumping ground
// for arbitrary client-controlled data.
// -----------------------------------------------------------------------

export const clinicalDetailsSchema = z
  .object({
    chiefComplaint: optionalTrimmedString(1000),
    observations: optionalTrimmedString(2000),
    diagnosis: optionalTrimmedString(1000),
    treatment: optionalTrimmedString(2000),
    followUpNotes: optionalTrimmedString(1000),
  })
  .strict();
export type ClinicalDetails = z.infer<typeof clinicalDetailsSchema>;

export const vaccinationDetailsSchema = z
  .object({
    vaccineName: requiredTrimmedString(200, "Vaccine name is required"),
    administeredAt: requiredDateOnly("administeredAt must be in YYYY-MM-DD format"),
    nextDueAt: optionalDateOnly("nextDueAt must be in YYYY-MM-DD format"),
    notes: optionalTrimmedString(1000),
  })
  .strict();
export type VaccinationDetails = z.infer<typeof vaccinationDetailsSchema>;

export const medicationDetailsSchema = z
  .object({
    medicationName: requiredTrimmedString(200, "Medication name is required"),
    dosage: requiredTrimmedString(100, "Dosage is required"),
    frequency: requiredTrimmedString(100, "Frequency is required"),
    route: optionalTrimmedString(50),
    duration: optionalTrimmedString(100),
    instructions: optionalTrimmedString(1000),
  })
  .strict();
export type MedicationDetails = z.infer<typeof medicationDetailsSchema>;

export const ALLERGY_SEVERITY_VALUES = ["MILD", "MODERATE", "SEVERE"] as const;
export const allergySeveritySchema = z.enum(ALLERGY_SEVERITY_VALUES);

export const allergyDetailsSchema = z
  .object({
    allergen: requiredTrimmedString(200, "Allergen is required"),
    reaction: optionalTrimmedString(500),
    severity: allergySeveritySchema.optional(),
    notes: optionalTrimmedString(1000),
  })
  .strict();
export type AllergyDetails = z.infer<typeof allergyDetailsSchema>;

export const labResultDetailsSchema = z
  .object({
    testName: requiredTrimmedString(200, "Test name is required"),
    result: requiredTrimmedString(500, "Result is required"),
    referenceRange: optionalTrimmedString(200),
    notes: optionalTrimmedString(1000),
  })
  .strict();
export type LabResultDetails = z.infer<typeof labResultDetailsSchema>;

export type MedicalRecordDetails =
  | ClinicalDetails
  | VaccinationDetails
  | MedicationDetails
  | AllergyDetails
  | LabResultDetails;

// The one place that maps a record type to its details shape. Both the
// create-input validator (below, via superRefine) and the API route (when
// re-parsing validated input into a typed value to persist) call through
// this single function, so the mapping can never drift between the two.
export function detailsSchemaForType(recordType: MedicalRecordType) {
  switch (recordType) {
    case "VACCINATION":
      return vaccinationDetailsSchema;
    case "MEDICATION":
      return medicationDetailsSchema;
    case "ALLERGY":
      return allergyDetailsSchema;
    case "LAB_RESULT":
      return labResultDetailsSchema;
    case "VISIT":
    case "DIAGNOSIS":
    case "SURGERY":
    case "OTHER":
      return clinicalDetailsSchema;
  }
}

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2000;

// providerId/bookingId are accepted here only as a DISAMBIGUATOR, never as
// an authorization credential — the route derives the actual authorized
// provider from the session and the pet's real booking history, and
// merely checks that a supplied providerId/bookingId is consistent with
// what it already independently derived. See
// apps/api/src/routes/medical-records.ts and docs/architecture.md,
// "Medical records — provider access model."
//
// createdByUserId, petId, and recordType-implying fields are never part
// of this schema at all — there is structurally no way for a client to
// supply them.
export const createMedicalRecordSchema = z
  .object({
    providerId: z.string().uuid("providerId must be a valid id").optional(),
    bookingId: z.string().uuid("bookingId must be a valid id").optional(),
    recordType: medicalRecordTypeSchema,
    title: requiredTrimmedString(MAX_TITLE, "Title is required"),
    description: optionalTrimmedString(MAX_DESCRIPTION),
    recordedAt: isoOffsetDateTimeSchema,
    details: z.unknown().optional(),
  })
  .superRefine((data, ctx) => {
    const schema = detailsSchemaForType(data.recordType);
    const result = schema.safeParse(data.details ?? {});
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: ["details", ...issue.path] });
      }
    }
  });
export type CreateMedicalRecordInput = z.infer<typeof createMedicalRecordSchema>;

// Only the content of a record may ever be amended — never its identity
// (petId, providerId, createdByUserId, bookingId, recordType, createdAt).
// See docs/architecture.md, "Historical integrity."
// Not .strict() — matching the rest of this codebase's Zod policy
// (unknown/extra fields are silently stripped, never rejected; see e.g.
// createBookingSchema's mass-assignment test). A client sending
// petId/providerId/createdByUserId here has them silently discarded by
// Zod itself before the route ever sees them, on top of the route also
// never reading those keys off parsed.data.
export const updateMedicalRecordSchema = z.object({
  title: requiredTrimmedString(MAX_TITLE, "Title is required").optional(),
  description: optionalTrimmedString(MAX_DESCRIPTION),
  recordedAt: isoOffsetDateTimeSchema.optional(),
  details: z.unknown().optional(),
});
export type UpdateMedicalRecordInput = z.infer<typeof updateMedicalRecordSchema>;

export const archiveMedicalRecordSchema = z.object({
  reason: optionalTrimmedString(500),
});
export type ArchiveMedicalRecordInput = z.infer<typeof archiveMedicalRecordSchema>;

export const medicalRecordListQuerySchema = z.object({
  recordType: medicalRecordTypeSchema.optional(),
  includeArchived: z
    .preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean().optional())
    .default(false),
});
export type MedicalRecordListQuery = z.infer<typeof medicalRecordListQuerySchema>;

// Never a raw database row. `details` is typed loosely here (its real
// shape depends on `recordType` — see MedicalRecordDetails/
// detailsSchemaForType) since Zod has no single static shape for a
// property whose type varies with a sibling field; callers narrow it
// themselves using recordType.
export const publicMedicalRecordSchema = z.object({
  id: z.string(),
  petId: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  bookingId: z.string().nullable(),
  recordType: medicalRecordTypeSchema,
  title: z.string(),
  description: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  recordedAt: z.string(),
  status: medicalRecordStatusSchema,
  archivedAt: z.string().nullable(),
  archivedReason: z.string().nullable(),
  createdByUserId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PublicMedicalRecord = z.infer<typeof publicMedicalRecordSchema>;

export const medicalRecordListResponseSchema = z.object({
  medicalRecords: z.array(publicMedicalRecordSchema),
});
export type MedicalRecordListResponse = z.infer<typeof medicalRecordListResponseSchema>;

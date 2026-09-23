export {
  createMedicalRecordSchema,
  updateMedicalRecordSchema,
  archiveMedicalRecordSchema,
  publicMedicalRecordSchema,
  medicalRecordTypeSchema,
  MEDICAL_RECORD_TYPE_VALUES,
  MEDICAL_RECORD_STATUS_VALUES,
  ALLERGY_SEVERITY_VALUES,
  detailsSchemaForType,
} from "@pawlink/shared";
export type {
  CreateMedicalRecordInput,
  UpdateMedicalRecordInput,
  ArchiveMedicalRecordInput,
  PublicMedicalRecord,
  MedicalRecordType,
  MedicalRecordStatus,
  ClinicalDetails,
  VaccinationDetails,
  MedicationDetails,
  AllergyDetails,
  LabResultDetails,
} from "@pawlink/shared";

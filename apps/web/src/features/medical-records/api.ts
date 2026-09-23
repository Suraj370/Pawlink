import { queryOptions } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type {
  ArchiveMedicalRecordInput,
  CreateMedicalRecordInput,
  MedicalRecordType,
  PublicMedicalRecord,
  UpdateMedicalRecordInput,
} from "./schemas";

type MedicalRecordResponse = { medicalRecord: PublicMedicalRecord };
type MedicalRecordListResponse = { medicalRecords: PublicMedicalRecord[] };

export type MedicalRecordFilters = {
  recordType?: MedicalRecordType;
  includeArchived?: boolean;
};

export async function listMedicalRecords(petId: string, filters: MedicalRecordFilters = {}): Promise<PublicMedicalRecord[]> {
  const searchParams: Record<string, string> = {};
  if (filters.recordType) searchParams.recordType = filters.recordType;
  if (filters.includeArchived) searchParams.includeArchived = "true";

  const { medicalRecords } = await apiClient
    .get(`api/pets/${petId}/medical-records`, { searchParams })
    .json<MedicalRecordListResponse>();
  return medicalRecords;
}

export async function getMedicalRecord(id: string): Promise<PublicMedicalRecord> {
  const { medicalRecord } = await apiClient.get(`api/medical-records/${id}`).json<MedicalRecordResponse>();
  return medicalRecord;
}

export async function createMedicalRecord(petId: string, input: CreateMedicalRecordInput): Promise<PublicMedicalRecord> {
  const { medicalRecord } = await apiClient
    .post(`api/pets/${petId}/medical-records`, { json: input })
    .json<MedicalRecordResponse>();
  return medicalRecord;
}

export async function updateMedicalRecord(id: string, input: UpdateMedicalRecordInput): Promise<PublicMedicalRecord> {
  const { medicalRecord } = await apiClient.patch(`api/medical-records/${id}`, { json: input }).json<MedicalRecordResponse>();
  return medicalRecord;
}

export async function archiveMedicalRecord(id: string, input: ArchiveMedicalRecordInput = {}): Promise<PublicMedicalRecord> {
  const { medicalRecord } = await apiClient
    .post(`api/medical-records/${id}/archive`, { json: input })
    .json<MedicalRecordResponse>();
  return medicalRecord;
}

export const medicalRecordsQueryOptions = (petId: string, filters: MedicalRecordFilters = {}) =>
  queryOptions({
    queryKey: ["medical-records", "pet", petId, filters] as const,
    queryFn: () => listMedicalRecords(petId, filters),
    enabled: !!petId,
  });

export const medicalRecordQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["medical-records", id] as const,
    queryFn: () => getMedicalRecord(id),
    enabled: !!id,
  });

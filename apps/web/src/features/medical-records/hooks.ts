import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  archiveMedicalRecord,
  createMedicalRecord,
  medicalRecordQueryOptions,
  medicalRecordsQueryOptions,
  updateMedicalRecord,
  type MedicalRecordFilters,
} from "./api";
import type { ArchiveMedicalRecordInput, CreateMedicalRecordInput, PublicMedicalRecord, UpdateMedicalRecordInput } from "./schemas";

export function useMedicalRecords(petId: string, filters: MedicalRecordFilters = {}) {
  return useQuery(medicalRecordsQueryOptions(petId, filters));
}

export function useMedicalRecord(id: string) {
  return useQuery(medicalRecordQueryOptions(id));
}

function invalidateAfterChange(queryClient: ReturnType<typeof useQueryClient>, record: PublicMedicalRecord) {
  queryClient.setQueryData(medicalRecordQueryOptions(record.id).queryKey, record);
  queryClient.invalidateQueries({ queryKey: ["medical-records", "pet", record.petId] });
}

export function useCreateMedicalRecord(petId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMedicalRecordInput) => createMedicalRecord(petId, input),
    onSuccess: (record) => invalidateAfterChange(queryClient, record),
  });
}

export function useUpdateMedicalRecord(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMedicalRecordInput) => updateMedicalRecord(id, input),
    onSuccess: (record) => invalidateAfterChange(queryClient, record),
  });
}

export function useArchiveMedicalRecord() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input?: ArchiveMedicalRecordInput }) => archiveMedicalRecord(id, input),
    onSuccess: (record) => invalidateAfterChange(queryClient, record),
  });
}

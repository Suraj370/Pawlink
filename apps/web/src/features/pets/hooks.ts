import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createPet, deletePet, petQueryOptions, petsQueryOptions, updatePet } from "./api";
import type { PublicPet, UpdatePetInput } from "./schemas";

export function usePets() {
  return useQuery(petsQueryOptions);
}

export function usePet(id: string) {
  return useQuery(petQueryOptions(id));
}

export function useCreatePet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createPet,
    onSuccess: (pet: PublicPet) => {
      queryClient.setQueryData(petQueryOptions(pet.id).queryKey, pet);
      queryClient.invalidateQueries({ queryKey: petsQueryOptions.queryKey });
    },
  });
}

export function useUpdatePet(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePetInput) => updatePet(id, input),
    onSuccess: (pet: PublicPet) => {
      queryClient.setQueryData(petQueryOptions(pet.id).queryKey, pet);
      queryClient.invalidateQueries({ queryKey: petsQueryOptions.queryKey });
    },
  });
}

export function useDeletePet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deletePet,
    onSuccess: (_data, id: string) => {
      queryClient.removeQueries({ queryKey: petQueryOptions(id).queryKey });
      queryClient.invalidateQueries({ queryKey: petsQueryOptions.queryKey });
    },
  });
}

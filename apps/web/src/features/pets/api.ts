import { queryOptions } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { CreatePetInput, PublicPet, UpdatePetInput } from "./schemas";

type PetResponse = { pet: PublicPet };
type PetsResponse = { pets: PublicPet[] };

export async function getPets(): Promise<PublicPet[]> {
  const { pets } = await apiClient.get("api/pets").json<PetsResponse>();
  return pets;
}

export async function getPet(id: string): Promise<PublicPet> {
  const { pet } = await apiClient.get(`api/pets/${id}`).json<PetResponse>();
  return pet;
}

export async function createPet(input: CreatePetInput): Promise<PublicPet> {
  const { pet } = await apiClient.post("api/pets", { json: input }).json<PetResponse>();
  return pet;
}

export async function updatePet(id: string, input: UpdatePetInput): Promise<PublicPet> {
  const { pet } = await apiClient.patch(`api/pets/${id}`, { json: input }).json<PetResponse>();
  return pet;
}

export async function deletePet(id: string): Promise<void> {
  await apiClient.delete(`api/pets/${id}`);
}

export const petsQueryOptions = queryOptions({
  queryKey: ["pets"] as const,
  queryFn: getPets,
});

export const petQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["pets", id] as const,
    queryFn: () => getPet(id),
  });

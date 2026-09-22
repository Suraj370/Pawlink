import type { PublicPet } from "@pawlink/shared";
import type { pets } from "../db/schema.js";

type PetRow = typeof pets.$inferSelect;

export function toPublicPet(pet: PetRow): PublicPet {
  return {
    id: pet.id,
    ownerId: pet.ownerId,
    name: pet.name,
    species: pet.species,
    breed: pet.breed,
    sex: pet.sex,
    dateOfBirth: pet.dateOfBirth,
    weight: pet.weight,
    photoUrl: pet.photoUrl,
    createdAt: pet.createdAt.toISOString(),
    updatedAt: pet.updatedAt.toISOString(),
  };
}

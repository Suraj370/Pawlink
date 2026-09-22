import { z } from "zod";

export const PET_SEX_VALUES = ["MALE", "FEMALE", "UNKNOWN"] as const;
export const petSexSchema = z.enum(PET_SEX_VALUES);
export type PetSex = z.infer<typeof petSexSchema>;

function emptyToUndefined(value: unknown) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const optionalTrimmedString = (max: number) =>
  z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

const optionalPhotoUrl = z.preprocess(
  emptyToUndefined,
  z.string().trim().url("Photo URL must be a valid URL").max(2048).optional(),
);

const MIN_BIRTH_DATE = "1990-01-01"; // sanity bound against absurd/garbage input
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const optionalDateOfBirth = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(DATE_RE, "Date of birth must be in YYYY-MM-DD format")
    .refine((value) => value >= MIN_BIRTH_DATE, "Date of birth is too far in the past")
    .refine((value) => value <= new Date().toISOString().slice(0, 10), "Date of birth cannot be in the future")
    .optional(),
);

const optionalWeight = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? undefined : value),
  z.coerce
    .number({ invalid_type_error: "Weight must be a number" })
    .positive("Weight must be positive")
    .max(1000, "Weight must be less than 1000kg")
    .optional(),
);

// A pet always needs a name and a species to be identifiable at all; every
// other field is information an owner may simply not have (a rescue's
// exact birth date, an unknown breed, a weight nobody has measured yet).
export const petInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  species: z.string().trim().min(1, "Species is required").max(60),
  breed: optionalTrimmedString(120),
  sex: petSexSchema.optional(),
  dateOfBirth: optionalDateOfBirth,
  weight: optionalWeight,
  photoUrl: optionalPhotoUrl,
});

export const createPetSchema = petInputSchema;
export type CreatePetInput = z.infer<typeof createPetSchema>;

// Partial update: every field optional, but any field that IS present is
// still validated by the same rules as creation.
export const updatePetSchema = petInputSchema.partial();
export type UpdatePetInput = z.infer<typeof updatePetSchema>;

export const publicPetSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  species: z.string(),
  breed: z.string().nullable(),
  sex: petSexSchema,
  dateOfBirth: z.string().nullable(),
  weight: z.number().nullable(),
  photoUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PublicPet = z.infer<typeof publicPetSchema>;

import { z } from "zod";
import { timezoneSchema } from "./availability.js";

export const PROVIDER_TYPE_VALUES = ["VET", "GROOMER", "BOARDING_PROVIDER", "PET_SHOP"] as const;
export const providerTypeSchema = z.enum(PROVIDER_TYPE_VALUES);
export type ProviderType = z.infer<typeof providerTypeSchema>;

export const PROVIDER_STATUS_VALUES = ["ACTIVE", "INACTIVE", "SUSPENDED"] as const;
export const providerStatusSchema = z.enum(PROVIDER_STATUS_VALUES);
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

// Only ACTIVE/INACTIVE are ever accepted directly from a client (owner)
// request body. SUSPENDED is enforced separately, server-side, by role —
// see assertStatusTransitionAllowed below — never by what the schema
// happens to accept, so it can't be bypassed by an unexpected shape.
export const ownerSettableStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);

function emptyToUndefined(value: unknown) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const optionalTrimmedString = (max: number) =>
  z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

const optionalEmail = z.preprocess(
  emptyToUndefined,
  z.string().trim().toLowerCase().email("Invalid email address").max(255).optional(),
);

const optionalLatitude = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? undefined : value),
  z.coerce
    .number({ invalid_type_error: "Latitude must be a number" })
    .min(-90, "Latitude must be between -90 and 90")
    .max(90, "Latitude must be between -90 and 90")
    .optional(),
);

const optionalLongitude = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? undefined : value),
  z.coerce
    .number({ invalid_type_error: "Longitude must be a number" })
    .min(-180, "Longitude must be between -180 and 180")
    .max(180, "Longitude must be between -180 and 180")
    .optional(),
);

// Only a business name and a provider type are required to list a
// provider at all; every contact/location field is optional so a listing
// can be created and filled in incrementally.
//
// timezone is optional on input (defaults to "UTC" server-side if omitted
// — see routes/providers.ts) but, when supplied, must be a genuine IANA
// identifier: a provider always HAS an explicit timezone, it just isn't
// mandatory to state one on every create call to avoid breaking existing
// provider-creation flows from before availability management existed.
export const providerInputSchema = z.object({
  businessName: z.string().trim().min(1, "Business name is required").max(200),
  providerType: providerTypeSchema,
  description: optionalTrimmedString(2000),
  phone: optionalTrimmedString(20),
  email: optionalEmail,
  address: optionalTrimmedString(255),
  city: optionalTrimmedString(120),
  state: optionalTrimmedString(120),
  postalCode: optionalTrimmedString(20),
  latitude: optionalLatitude,
  longitude: optionalLongitude,
  timezone: timezoneSchema.optional(),
});

// Creation never accepts ownerId or status: ownership is derived from the
// session and every new provider starts ACTIVE, mirroring how
// registerSchema has no role field.
export const createProviderSchema = providerInputSchema;
export type CreateProviderInput = z.infer<typeof createProviderSchema>;

// Partial update, plus a status field. Every field present is still
// validated by the same rules as creation. Which status values are
// *accepted by the schema* depends on the caller's role — an admin needs
// SUSPENDED to be a legal shape at all, or their request would be
// rejected as invalid input before the role check in the route handler
// ever runs. The route always picks updateProviderSchema unless the
// authenticated caller's role is ADMIN.
export const updateProviderSchema = providerInputSchema.partial().extend({
  status: ownerSettableStatusSchema.optional(),
});
export type UpdateProviderInput = z.infer<typeof updateProviderSchema>;

export const adminUpdateProviderSchema = providerInputSchema.partial().extend({
  status: providerStatusSchema.optional(),
});
export type AdminUpdateProviderInput = z.infer<typeof adminUpdateProviderSchema>;

// Never includes ownerId. isOwner is a computed boolean (true only when
// the requester is authenticated as the owner or an admin) so the
// frontend can gate Edit/Delete UI without the raw foreign key ever
// leaving the server. averageRating/reviewCount are the same aggregate
// reviews.ts's reviewAggregateSchema describes — computed fresh from the
// reviews table on every request (see routes/providers.ts), never a
// cached/stale value stored on the provider row itself.
export const publicProviderSchema = z.object({
  id: z.string(),
  businessName: z.string(),
  providerType: providerTypeSchema,
  description: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  timezone: z.string(),
  status: providerStatusSchema,
  isOwner: z.boolean(),
  averageRating: z.number().nullable(),
  reviewCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PublicProvider = z.infer<typeof publicProviderSchema>;

export const providerListQuerySchema = z.object({
  providerType: providerTypeSchema.optional(),
  city: z.string().trim().max(120).optional(),
  status: providerStatusSchema.optional(),
  page: z.coerce.number().int().positive().catch(1),
  pageSize: z.coerce.number().int().positive().max(50).catch(20),
});
export type ProviderListQuery = z.infer<typeof providerListQuerySchema>;

export const providerListResponseSchema = z.object({
  providers: z.array(publicProviderSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});
export type ProviderListResponse = z.infer<typeof providerListResponseSchema>;

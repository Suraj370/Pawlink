import { z } from "zod";

// Money is never stored or transmitted as a float. priceMinor is an
// integer count of the currency's smallest unit (e.g. ₹799.00 -> 79900
// paise), so no floating-point arithmetic ever touches a persisted price.
// The API's DTO field is deliberately named priceMinor (not "price") so
// every consumer is forced to be explicit about the unit rather than
// guessing whether a number is major or minor units.
const MAX_PRICE_MINOR = 100_000_000; // sanity bound: 1,000,000.00 in major units
const MAX_DURATION_MINUTES = 24 * 60; // a single bookable service can't span more than a day

// Shape-only ISO 4217 alpha-3 validation (e.g. INR, USD, EUR). This
// milestone doesn't restrict to a specific supported-currency list —
// that belongs with the future payments milestone, once a payment
// processor's supported-currency set is known.
export const DEFAULT_CURRENCY = "INR";
export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter ISO 4217 code (e.g. INR, USD)");
export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

function emptyToUndefined(value: unknown) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const optionalDescription = z.preprocess(emptyToUndefined, z.string().trim().max(2000).optional());

const optionalCurrency = z.preprocess(emptyToUndefined, currencyCodeSchema.optional());

export const serviceInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(150),
  description: optionalDescription,
  durationMinutes: z.coerce
    .number({ invalid_type_error: "Duration must be a number" })
    .int("Duration must be a whole number of minutes")
    .positive("Duration must be greater than zero")
    .max(MAX_DURATION_MINUTES, "Duration is unreasonably long"),
  priceMinor: z.coerce
    .number({ invalid_type_error: "Price must be a number" })
    .int("Price must be a whole number of minor currency units (e.g. paise, cents)")
    .min(0, "Price cannot be negative")
    .max(MAX_PRICE_MINOR, "Price is unreasonably large"),
  currency: optionalCurrency,
  active: z.boolean().optional(),
});

// Creation never accepts providerId: the provider comes from the URL
// (/api/providers/:providerId/services) and ownership of THAT provider is
// verified against the authenticated session server-side — the request
// body has no way to name a different provider at all.
export const createServiceSchema = serviceInputSchema;
export type CreateServiceInput = z.infer<typeof createServiceSchema>;

// Partial update, including active (true reactivates, false deactivates —
// the same field DELETE /api/providers/:providerId/services/:serviceId
// sets to false as a soft delete).
export const updateServiceSchema = serviceInputSchema.partial();
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;

export const publicServiceSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  durationMinutes: z.number(),
  priceMinor: z.number(),
  currency: z.string(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PublicService = z.infer<typeof publicServiceSchema>;

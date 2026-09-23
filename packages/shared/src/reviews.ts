import { z } from "zod";

// Not yet exposed through any endpoint that lets a client choose it — see
// the milestone brief's "design the schema so a future state can be
// introduced without rewriting everything." Every review created today is
// PUBLISHED; HIDDEN exists purely as a forward-compatible hook for a
// later moderation milestone (see docs/architecture.md, "Reviews &
// ratings").
export const REVIEW_STATUS_VALUES = ["PUBLISHED", "HIDDEN"] as const;
export const reviewStatusSchema = z.enum(REVIEW_STATUS_VALUES);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

const MAX_TITLE = 150;
const MAX_COMMENT = 2000;

function emptyToUndefined(value: unknown) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

// A title/comment of only whitespace is treated as absent, not as
// meaningful content — trimmed before length-checking and before storage,
// so "   " never becomes a stored title distinct from no title at all.
const optionalTrimmedString = (max: number) =>
  z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

// Ratings are a closed integer range, never an arbitrary number — 0, 6,
// -1, and 3.5 are all rejected by construction (z.number().int() alone
// would still accept 3.5's rounding-adjacent neighbors like 3.0, so the
// explicit min/max AND int() are both required).
export const ratingSchema = z
  .number({ invalid_type_error: "Rating must be a number" })
  .int("Rating must be a whole number")
  .min(1, "Rating must be between 1 and 5")
  .max(5, "Rating must be between 1 and 5");

// bookingId/customerUserId/providerId are never part of this schema —
// they come solely from the URL (bookingId) and from the booking row
// itself (customerUserId, providerId), never the request body. See
// routes/reviews.ts and docs/architecture.md, "Reviews & ratings."
export const createReviewSchema = z.object({
  rating: ratingSchema,
  title: optionalTrimmedString(MAX_TITLE),
  comment: optionalTrimmedString(MAX_COMMENT),
});
export type CreateReviewInput = z.infer<typeof createReviewSchema>;

// Only content may ever be amended — never booking_id/customer_user_id/
// provider_id/created_at, which aren't fields on this schema at all.
export const updateReviewSchema = z.object({
  rating: ratingSchema.optional(),
  title: optionalTrimmedString(MAX_TITLE),
  comment: optionalTrimmedString(MAX_COMMENT),
});
export type UpdateReviewInput = z.infer<typeof updateReviewSchema>;

// Never includes customerUserId or any other internal identifier — see
// docs/architecture.md, "Customer review privacy." reviewerDisplayName is
// a derived, PII-minimized presentation of the reviewing customer's name
// (see lib/review.ts's toReviewerDisplayName), never their email or raw
// account name.
export const publicReviewSchema = z.object({
  id: z.string(),
  bookingId: z.string(),
  providerId: z.string(),
  rating: z.number(),
  title: z.string().nullable(),
  comment: z.string().nullable(),
  reviewerDisplayName: z.string(),
  status: reviewStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PublicReview = z.infer<typeof publicReviewSchema>;

export const reviewListQuerySchema = z.object({
  page: z.coerce.number().int().positive().catch(1),
  pageSize: z.coerce.number().int().positive().max(50).catch(20),
});
export type ReviewListQuery = z.infer<typeof reviewListQuerySchema>;

// averageRating is null (not 0) when reviewCount is 0 — a provider with
// no reviews has no average, not a zero-star one. When present, it's
// rounded to 2 decimal places (see lib/review.ts).
export const reviewAggregateSchema = z.object({
  averageRating: z.number().nullable(),
  reviewCount: z.number(),
});
export type ReviewAggregate = z.infer<typeof reviewAggregateSchema>;

export const reviewListResponseSchema = z.object({
  reviews: z.array(publicReviewSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  aggregate: reviewAggregateSchema,
});
export type ReviewListResponse = z.infer<typeof reviewListResponseSchema>;

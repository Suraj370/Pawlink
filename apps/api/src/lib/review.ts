import { and, eq, inArray, sql } from "drizzle-orm";
import type { PublicReview, ReviewAggregate } from "@pawlink/shared";
import type { DbClient } from "../db/client.js";
import { reviews } from "../db/schema.js";

type ReviewRow = typeof reviews.$inferSelect;

// A PII-minimized presentation of the reviewing customer's stored account
// name — never their email, never their raw account name in full, never
// an internal id. "Suraj Panda" -> "Suraj P."; a single-token name is
// shown as-is ("Cher" -> "Cher"); an empty/whitespace-only name (should
// never happen — users.name is required at registration, but this stays
// defensive rather than crashing a review render) falls back to
// "Verified customer". See docs/architecture.md, "Customer review
// privacy," for why a full name or email is never shown publicly.
export function toReviewerDisplayName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Verified customer";
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const lastInitial = parts[parts.length - 1][0];
  return `${first} ${lastInitial}.`;
}

export function toPublicReview(review: ReviewRow, reviewerDisplayName: string): PublicReview {
  return {
    id: review.id,
    bookingId: review.bookingId,
    providerId: review.providerId,
    rating: review.rating,
    title: review.title,
    comment: review.comment,
    reviewerDisplayName,
    status: review.status,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
  };
}

// Rounds to 2 decimal places without floating-point drift accumulating
// across many rows — the aggregation itself (SUM/COUNT) happens in
// Postgres (see routes/providers.ts, routes/reviews.ts), never by pulling
// every row into the application and summing in JavaScript; this only
// rounds the single resulting ratio. null in, null out: a provider with
// zero reviews has no average, never a misleading 0.
export function roundRating(sum: number, count: number): number | null {
  if (count === 0) return null;
  return Math.round((sum / count) * 100) / 100;
}

const EMPTY_AGGREGATE: ReviewAggregate = { averageRating: null, reviewCount: 0 };

// Computes {averageRating, reviewCount} for a batch of providers in a
// SINGLE grouped query (never one query per provider — see the milestone
// brief's "avoid calculating the entire review table inefficiently on
// every provider page") — only PUBLISHED reviews count, so a future
// HIDDEN/moderated review can never inflate a rating. A provider with no
// (or no published) reviews simply doesn't appear in the result and gets
// the caller-supplied default of {averageRating: null, reviewCount: 0}.
export async function getReviewAggregates(
  queryable: Pick<DbClient, "select">,
  providerIds: string[],
): Promise<Map<string, ReviewAggregate>> {
  const result = new Map<string, ReviewAggregate>();
  if (providerIds.length === 0) return result;

  const rows = await queryable
    .select({
      providerId: reviews.providerId,
      sum: sql<number>`sum(${reviews.rating})::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(reviews)
    .where(and(inArray(reviews.providerId, [...new Set(providerIds)]), eq(reviews.status, "PUBLISHED")))
    .groupBy(reviews.providerId);

  for (const row of rows) {
    result.set(row.providerId, { averageRating: roundRating(row.sum, row.count), reviewCount: row.count });
  }
  return result;
}

export async function getReviewAggregate(queryable: Pick<DbClient, "select">, providerId: string): Promise<ReviewAggregate> {
  const map = await getReviewAggregates(queryable, [providerId]);
  return map.get(providerId) ?? EMPTY_AGGREGATE;
}

export { EMPTY_AGGREGATE };

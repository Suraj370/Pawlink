import { useProviderReviews } from "../hooks"
import { StarRating } from "./StarRating"

// Public — no auth required, matches GET /api/providers/:providerId/reviews.
// Never renders review text as raw HTML: title/comment are plain React
// text children, escaped by React by construction, so a stored
// "<script>...</script>" payload renders as inert text, never executes.
export function ProviderReviewsList({ providerId }: { providerId: string }) {
  const { data, isLoading, isError } = useProviderReviews(providerId)

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading reviews…</p>
  }
  if (isError || !data) {
    return <p className="text-sm text-destructive">Could not load reviews.</p>
  }

  return (
    <section className="flex flex-col gap-4" data-testid="provider-reviews-section">
      <div className="flex items-center gap-2" data-testid="provider-rating-summary">
        {data.aggregate.averageRating !== null ? (
          <>
            <StarRating value={Math.round(data.aggregate.averageRating)} readOnly size="sm" />
            <span className="text-sm font-medium">{data.aggregate.averageRating.toFixed(2)}</span>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">No ratings yet</span>
        )}
        <span className="text-sm text-muted-foreground">
          ({data.aggregate.reviewCount} review{data.aggregate.reviewCount === 1 ? "" : "s"})
        </span>
      </div>

      {data.reviews.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="provider-reviews-empty-state">
          No reviews yet.
        </p>
      )}

      {data.reviews.length > 0 && (
        <ul className="flex flex-col gap-3" data-testid="provider-reviews-list">
          {data.reviews.map((review) => (
            <li key={review.id} className="flex flex-col gap-1 rounded border border-border p-3" data-testid="provider-review-row">
              <div className="flex items-center justify-between">
                <StarRating value={review.rating} readOnly size="sm" />
                <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">Verified booking</span>
              </div>
              {review.title && <p className="text-sm font-medium">{review.title}</p>}
              {review.comment && <p className="text-sm">{review.comment}</p>}
              <p className="text-xs text-muted-foreground">
                {review.reviewerDisplayName} · {review.createdAt.slice(0, 10)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

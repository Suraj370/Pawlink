import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/api/errors"
import { Pagination } from "@/features/admin/components/Pagination"
import { useAdminReviews, useModerateAdminReview } from "@/features/admin/hooks"

export const Route = createFileRoute("/_authenticated/admin/reviews")({
  component: AdminReviewsPage,
})

const REVIEW_STATUS_VALUES = ["PUBLISHED", "HIDDEN"] as const
const PAGE_SIZE = 50

function AdminReviewsPage() {
  const [status, setStatus] = useState<(typeof REVIEW_STATUS_VALUES)[number] | "">("")
  const [page, setPage] = useState(1)
  const { data, isLoading, isError } = useAdminReviews({ status: status || undefined, page, pageSize: PAGE_SIZE })
  const moderate = useModerateAdminReview()
  const [error, setError] = useState<string | null>(null)

  async function handleModerate(id: string, action: "hide" | "publish") {
    setError(null)
    try {
      await moderate.mutateAsync({ id, action })
    } catch (err) {
      setError(await toErrorMessage(err, "Could not update this review"))
    }
  }

  return (
    <section className="flex flex-col gap-4" data-testid="admin-reviews-page">
      <select
        value={status}
        onChange={(e) => {
          setStatus(e.target.value as typeof status)
          setPage(1)
        }}
        className="rounded border border-border bg-background px-3 py-2 text-sm"
      >
        <option value="">All statuses</option>
        {REVIEW_STATUS_VALUES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      {isLoading && <p className="text-sm text-muted-foreground">Loading reviews…</p>}
      {isError && <p className="text-sm text-destructive">Could not load reviews.</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {data && (
        <>
          <ul className="flex flex-col gap-2" data-testid="admin-reviews-list">
            {data.reviews.map((review) => (
              <li key={review.id} className="rounded border border-border p-3 text-sm" data-testid="admin-review-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{review.rating} ★ {review.title ?? ""}</span>
                  <span className="text-muted-foreground">{review.status}</span>
                </div>
                {review.comment && <p>{review.comment}</p>}
                <p className="text-muted-foreground">
                  {review.reviewerDisplayName} · {review.createdAt.slice(0, 10)}
                </p>
                <div className="mt-2">
                  {review.status === "PUBLISHED" ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      isDisabled={moderate.isPending}
                      onPress={() => handleModerate(review.id, "hide")}
                      data-testid="admin-review-hide-button"
                    >
                      Hide
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      isDisabled={moderate.isPending}
                      onPress={() => handleModerate(review.id, "publish")}
                      data-testid="admin-review-publish-button"
                    >
                      Republish
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {data.reviews.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="admin-reviews-empty-state">
              No reviews match this filter.
            </p>
          )}
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
        </>
      )}
    </section>
  )
}

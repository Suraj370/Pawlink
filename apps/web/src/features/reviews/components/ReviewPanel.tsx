import { useState } from "react"
import { HTTPError } from "ky"
import { Button } from "@/components/ui/button"
import { useBookingReview, useCreateBookingReview, useUpdateReview } from "../hooks"
import { ReviewForm } from "./ReviewForm"
import { StarRating } from "./StarRating"

// Mounted on the booking detail page only when booking.status ===
// "COMPLETED" — see routes/_authenticated/bookings/$bookingId.tsx.
// Server-side authorization is the real gate (only the booking's own
// customer can create/see this review); this component just reflects
// whatever the API says, the same "server decides, UI reflects" pattern
// PaymentPanel already uses.
export function ReviewPanel({ bookingId }: { bookingId: string }) {
  const { data: review, isLoading, error } = useBookingReview(bookingId)
  const createReview = useCreateBookingReview(bookingId)
  const updateReview = useUpdateReview(review?.id ?? "")
  const [isEditing, setIsEditing] = useState(false)

  const noReviewYet = error instanceof HTTPError && error.response.status === 404

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading review…</p>
  }

  if (!review && !noReviewYet) {
    return <p className="text-sm text-destructive">Could not load review status.</p>
  }

  if (!review || isEditing) {
    return (
      <div className="flex flex-col gap-3 rounded border border-border p-4" data-testid="review-panel">
        <h4 className="font-medium">{review ? "Edit your review" : "Write a review"}</h4>
        <ReviewForm
          initialValues={review ?? undefined}
          submitLabel={review ? "Save changes" : "Submit review"}
          pending={review ? updateReview.isPending : createReview.isPending}
          onSubmit={async (input) => {
            if (review) {
              await updateReview.mutateAsync(input)
              setIsEditing(false)
            } else {
              await createReview.mutateAsync(input)
            }
          }}
          onCancel={review ? () => setIsEditing(false) : undefined}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-border p-4" data-testid="review-panel">
      <div className="flex items-center justify-between">
        <h4 className="font-medium">Your review</h4>
        <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground" data-testid="verified-booking-badge">
          Verified booking
        </span>
      </div>
      <StarRating value={review.rating} readOnly />
      {review.title && <p className="text-sm font-medium" data-testid="review-title">{review.title}</p>}
      {review.comment && <p className="text-sm" data-testid="review-comment">{review.comment}</p>}
      <div>
        <Button size="sm" variant="outline" onPress={() => setIsEditing(true)} data-testid="edit-review-button">
          Edit review
        </Button>
      </div>
    </div>
  )
}

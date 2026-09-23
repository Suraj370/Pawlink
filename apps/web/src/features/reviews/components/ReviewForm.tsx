import { useState } from "react"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/api/errors"
import { createReviewSchema } from "../schemas"
import type { CreateReviewInput, PublicReview } from "../schemas"
import { StarRating } from "./StarRating"

const MAX_TITLE = 150
const MAX_COMMENT = 2000

type Props = {
  initialValues?: Pick<PublicReview, "rating" | "title" | "comment">
  submitLabel: string
  pending: boolean
  onSubmit: (input: CreateReviewInput) => Promise<void>
  onCancel?: () => void
}

export function ReviewForm({ initialValues, submitLabel, pending, onSubmit, onCancel }: Props) {
  const [rating, setRating] = useState(initialValues?.rating ?? 0)
  const [title, setTitle] = useState(initialValues?.title ?? "")
  const [comment, setComment] = useState(initialValues?.comment ?? "")
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFieldError(null)
    setSubmitError(null)

    if (rating < 1) {
      setFieldError("Please select a rating")
      return
    }

    // Client-side validation is a UX convenience only — the API
    // independently re-validates with the same schema.
    const parsed = createReviewSchema.safeParse({ rating, title, comment })
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Invalid input")
      return
    }

    try {
      await onSubmit(parsed.data)
    } catch (err) {
      setSubmitError(await toErrorMessage(err, "Could not submit review"))
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate data-testid="review-form">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Rating</span>
        <StarRating value={rating} onChange={setRating} />
      </div>
      <label className="flex flex-col gap-1 text-sm">
        Title (optional)
        <input
          type="text"
          value={title}
          maxLength={MAX_TITLE}
          onChange={(e) => setTitle(e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        />
        <span className="text-xs text-muted-foreground">{title.length}/{MAX_TITLE}</span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Comment (optional)
        <textarea
          value={comment}
          maxLength={MAX_COMMENT}
          onChange={(e) => setComment(e.target.value)}
          rows={4}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        />
        <span className="text-xs text-muted-foreground">{comment.length}/{MAX_COMMENT}</span>
      </label>
      {(fieldError ?? submitError) && (
        <p role="alert" className="text-sm text-destructive" data-testid="review-form-error">
          {fieldError ?? submitError}
        </p>
      )}
      <div className="flex gap-3">
        <Button type="submit" isDisabled={pending} data-testid="review-submit-button">
          {pending ? "Saving…" : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onPress={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}

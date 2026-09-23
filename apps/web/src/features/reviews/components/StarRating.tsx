const STARS = [1, 2, 3, 4, 5] as const

// A plain, accessible 1–5 selector — radio-group semantics via role="radio"
// buttons, not a custom drag/hover-only widget, so it works with keyboard
// and screen readers without extra plumbing.
export function StarRating({
  value,
  onChange,
  readOnly = false,
  size = "md",
}: {
  value: number
  onChange?: (value: number) => void
  readOnly?: boolean
  size?: "sm" | "md"
}) {
  const starClass = size === "sm" ? "text-base" : "text-2xl"

  return (
    <div role={readOnly ? undefined : "radiogroup"} aria-label="Rating" className="flex gap-1" data-testid="star-rating">
      {STARS.map((star) => {
        const filled = star <= value
        if (readOnly) {
          return (
            <span key={star} className={`${starClass} ${filled ? "text-yellow-500" : "text-muted-foreground/30"}`} aria-hidden>
              ★
            </span>
          )
        }
        return (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={star === value}
            aria-label={`${star} star${star === 1 ? "" : "s"}`}
            onClick={() => onChange?.(star)}
            className={`${starClass} leading-none ${filled ? "text-yellow-500" : "text-muted-foreground/30"} hover:text-yellow-400`}
            data-testid={`star-rating-${star}`}
          >
            ★
          </button>
        )
      })}
    </div>
  )
}

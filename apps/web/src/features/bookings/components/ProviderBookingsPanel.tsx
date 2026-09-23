import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/api/errors"
import { useBookings, useCancelBooking } from "../hooks"

export function ProviderBookingsPanel({ providerId }: { providerId: string }) {
  const { data, isLoading, isError } = useBookings({ providerId })
  const cancelBooking = useCancelBooking()
  const [error, setError] = useState<string | null>(null)

  async function handleCancel(bookingId: string) {
    if (!window.confirm("Cancel this booking?")) return
    setError(null)
    try {
      await cancelBooking.mutateAsync(bookingId)
    } catch (err) {
      setError(await toErrorMessage(err, "Could not cancel this booking"))
    }
  }

  return (
    <section className="flex flex-col gap-3" data-testid="provider-bookings-panel">
      <h2 className="text-lg font-semibold">Bookings</h2>

      {isLoading && <p className="text-sm text-muted-foreground">Loading bookings…</p>}
      {isError && <p className="text-sm text-destructive">Could not load bookings.</p>}
      {data && data.bookings.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="provider-bookings-empty-state">
          No bookings yet.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {data && data.bookings.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="provider-bookings-list">
          {data.bookings.map((booking) => {
            const canCancel = booking.status === "PENDING" || booking.status === "CONFIRMED"
            // Same legitimacy rule the API enforces for medical-record
            // access (CONFIRMED/COMPLETED only) — a PENDING or CANCELLED
            // booking never establishes a treating relationship, so the
            // link is only offered when it would actually work.
            const hasLegitimateRelationship = booking.status === "CONFIRMED" || booking.status === "COMPLETED"
            return (
              <li
                key={booking.id}
                className="flex items-center justify-between rounded border border-border p-3"
                data-testid="provider-booking-row"
              >
                <span className="text-sm">
                  <strong>{booking.serviceName}</strong> — {booking.startAt.slice(0, 10)}{" "}
                  {booking.startAt.slice(11, 16)} · {booking.status}
                </span>
                <div className="flex gap-2">
                  {hasLegitimateRelationship && (
                    <Link
                      to="/provider-medical-records/$petId"
                      params={{ petId: booking.petId }}
                      className="text-sm underline underline-offset-4"
                      data-testid="provider-booking-medical-records-link"
                    >
                      Medical records
                    </Link>
                  )}
                  {canCancel && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onPress={() => handleCancel(booking.id)}
                      isDisabled={cancelBooking.isPending}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

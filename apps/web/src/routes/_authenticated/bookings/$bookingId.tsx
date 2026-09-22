import { useState } from "react"
import { HTTPError } from "ky"
import { Link, createFileRoute } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/api/errors"
import { useBooking, useCancelBooking } from "@/features/bookings/hooks"
import { PaymentPanel } from "@/features/payments/components/PaymentPanel"
import { priceMinorToMajor } from "@/features/services/money"

export const Route = createFileRoute("/_authenticated/bookings/$bookingId")({
  component: BookingDetailsPage,
})

function BookingDetailsPage() {
  const { bookingId } = Route.useParams()
  const { data: booking, isLoading, error } = useBooking(bookingId)
  const cancelBooking = useCancelBooking()
  const [cancelError, setCancelError] = useState<string | null>(null)

  const notFound = error instanceof HTTPError && error.response.status === 404

  if (isLoading) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <p className="text-sm text-muted-foreground">Loading booking…</p>
      </main>
    )
  }

  if (notFound || !booking) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
        <p className="text-sm text-destructive" data-testid="booking-not-found">
          Booking not found.
        </p>
        <Link to="/bookings" className="text-sm underline underline-offset-4">
          Back to My Bookings
        </Link>
      </main>
    )
  }

  const canCancel = booking.status === "PENDING" || booking.status === "CONFIRMED"

  async function handleCancel() {
    if (!window.confirm("Cancel this booking?")) return
    setCancelError(null)
    try {
      await cancelBooking.mutateAsync(booking!.id)
    } catch (err) {
      setCancelError(await toErrorMessage(err, "Could not cancel this booking"))
    }
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div>
        <Link to="/bookings" className="text-sm underline underline-offset-4">
          Back to My Bookings
        </Link>
      </div>
      <h1 className="text-xl font-semibold" data-testid="booking-detail-service-name">
        {booking.serviceName}
      </h1>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Status</dt>
        <dd data-testid="booking-status">{booking.status}</dd>
        <dt className="text-muted-foreground">Date</dt>
        <dd>{booking.startAt.slice(0, 10)}</dd>
        <dt className="text-muted-foreground">Time</dt>
        <dd>
          {booking.startAt.slice(11, 16)}–{booking.endAt.slice(11, 16)}
        </dd>
        <dt className="text-muted-foreground">Duration</dt>
        <dd>{booking.serviceDurationMinutes} minutes</dd>
        <dt className="text-muted-foreground">Price</dt>
        <dd>
          {booking.currency} {priceMinorToMajor(booking.priceMinor)}
        </dd>
      </dl>
      {booking.status === "PENDING" && (
        <PaymentPanel bookingId={booking.id} amountMinor={booking.priceMinor} currency={booking.currency} />
      )}
      {cancelError && (
        <p role="alert" className="text-sm text-destructive">
          {cancelError}
        </p>
      )}
      {canCancel && (
        <Button variant="destructive" onPress={handleCancel} isDisabled={cancelBooking.isPending} className="w-fit">
          {cancelBooking.isPending ? "Cancelling…" : "Cancel booking"}
        </Button>
      )}
    </main>
  )
}

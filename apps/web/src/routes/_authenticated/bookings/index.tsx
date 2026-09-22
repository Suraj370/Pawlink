import { Link, createFileRoute } from "@tanstack/react-router"
import { useBookings } from "@/features/bookings/hooks"

export const Route = createFileRoute("/_authenticated/bookings/")({
  component: BookingsPage,
})

function BookingsPage() {
  const { data, isLoading, isError } = useBookings()

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <h1 className="text-xl font-semibold">My Bookings</h1>

      {isLoading && <p className="text-sm text-muted-foreground">Loading bookings…</p>}
      {isError && <p className="text-sm text-destructive">Could not load your bookings.</p>}

      {data && data.bookings.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="bookings-empty-state">
          You haven't booked anything yet.
        </p>
      )}

      {data && data.bookings.length > 0 && (
        <ul className="flex flex-col gap-3" data-testid="bookings-list">
          {data.bookings.map((booking) => (
            <li key={booking.id} className="rounded border border-border p-4" data-testid="booking-row">
              <Link to="/bookings/$bookingId" params={{ bookingId: booking.id }} className="flex flex-col gap-1">
                <span className="font-medium" data-testid="booking-service-name">
                  {booking.serviceName}
                </span>
                <span className="text-sm text-muted-foreground">
                  {booking.startAt.slice(0, 10)} {booking.startAt.slice(11, 16)} · {booking.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

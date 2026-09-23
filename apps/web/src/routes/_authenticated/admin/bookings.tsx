import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Pagination } from "@/features/admin/components/Pagination"
import { useAdminBookings } from "@/features/admin/hooks"
import { priceMinorToMajor } from "@/features/services/money"

export const Route = createFileRoute("/_authenticated/admin/bookings")({
  component: AdminBookingsPage,
})

const BOOKING_STATUS_VALUES = ["PENDING", "CONFIRMED", "CANCELLED", "COMPLETED"] as const
const PAYMENT_STATUS_VALUES = ["NONE", "CREATED", "PENDING", "SUCCEEDED", "FAILED", "CANCELLED"] as const
const PAGE_SIZE = 20

function AdminBookingsPage() {
  const [status, setStatus] = useState<(typeof BOOKING_STATUS_VALUES)[number] | "">("")
  const [paymentStatus, setPaymentStatus] = useState<(typeof PAYMENT_STATUS_VALUES)[number] | "">("")
  const [page, setPage] = useState(1)
  const { data, isLoading, isError } = useAdminBookings({
    status: status || undefined,
    paymentStatus: paymentStatus || undefined,
    page,
    pageSize: PAGE_SIZE,
  })

  return (
    <section className="flex flex-col gap-4" data-testid="admin-bookings-page">
      <div className="flex flex-wrap gap-3">
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as typeof status)
            setPage(1)
          }}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="">All booking statuses</option>
          {BOOKING_STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={paymentStatus}
          onChange={(e) => {
            setPaymentStatus(e.target.value as typeof paymentStatus)
            setPage(1)
          }}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="">All payment statuses</option>
          {PAYMENT_STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading bookings…</p>}
      {isError && <p className="text-sm text-destructive">Could not load bookings.</p>}

      {data && (
        <>
          <ul className="flex flex-col gap-2" data-testid="admin-bookings-list">
            {data.bookings.map((booking) => (
              <li key={booking.id} className="rounded border border-border p-3 text-sm" data-testid="admin-booking-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{booking.serviceName}</span>
                  <span className="text-muted-foreground">
                    {booking.status} · payment: {booking.paymentStatus}
                  </span>
                </div>
                <p className="text-muted-foreground">
                  {booking.customerName} → {booking.providerName} · {booking.startAt.slice(0, 10)}{" "}
                  {booking.startAt.slice(11, 16)} · {booking.currency} {priceMinorToMajor(booking.priceMinor)}
                </p>
              </li>
            ))}
          </ul>
          {data.bookings.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="admin-bookings-empty-state">
              No bookings match this filter.
            </p>
          )}
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
        </>
      )}
    </section>
  )
}

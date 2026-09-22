import { useEffect, useRef } from "react"
import { PaymentPanel } from "@/features/payments/components/PaymentPanel"
import { useBooking } from "../hooks"
import type { PublicBooking } from "../schemas"

type Props = {
  bookingId: string
  onConfirmed: (booking: PublicBooking) => void
}

// The booking created just before this step is PENDING, not CONFIRMED —
// this step's only job is to show the payment panel and react to
// whatever the SERVER'S booking status actually becomes afterward. This
// component never sets confirmation itself; it only watches the booking
// query (which PaymentPanel's mutation invalidates on every payment
// attempt) and hands control back to the caller once the server has
// genuinely moved the booking to CONFIRMED.
export function BookingPaymentStep({ bookingId, onConfirmed }: Props) {
  const { data: booking, isLoading } = useBooking(bookingId)
  const notifiedRef = useRef(false)

  useEffect(() => {
    if (booking?.status === "CONFIRMED" && !notifiedRef.current) {
      notifiedRef.current = true
      onConfirmed(booking)
    }
  }, [booking, onConfirmed])

  if (isLoading || !booking) {
    return <p className="text-sm text-muted-foreground">Loading booking…</p>
  }

  return <PaymentPanel bookingId={bookingId} amountMinor={booking.priceMinor} currency={booking.currency} />
}

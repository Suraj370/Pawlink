import { PaymentPanel } from "@/features/payments/components/PaymentPanel"
import type { PublicPayment } from "@/features/payments/schemas"
import { useBooking } from "../hooks"
import type { PublicBooking } from "../schemas"

type Props = {
  bookingId: string
  onConfirmed: (booking: PublicBooking) => void
}

// The booking created just before this step is PENDING, not CONFIRMED —
// this step's only job is to show the payment panel and react to
// whatever the SERVER'S booking status actually becomes afterward.
//
// This deliberately does NOT watch the booking query independently and
// advance whenever it happens to observe CONFIRMED (an earlier version
// did exactly that, via useEffect). That shape has a real race: the
// payment mutation's onSuccess (useCreatePayment, features/payments/
// hooks.ts) both (a) synchronously seeds the payment query so
// PaymentPanel can paint "Payment successful" immediately, and (b)
// separately, asynchronously invalidates the booking query in the
// background. Nothing sequences those two — under load, React can
// coalesce both resulting re-renders into a single commit and paint
// only the LATER one, so the confirmation view can replace PaymentPanel
// without the "Payment successful" state ever being rendered at all.
//
// Instead, this step drives the sequence itself off PaymentPanel's own
// onSettled callback — fired only once the payment mutation itself has
// resolved, with the payment PaymentPanel is already showing as
// "succeeded" — and only THEN explicitly (and asynchronously) refetches
// the booking, advancing only once that fetch confirms CONFIRMED. That
// refetch is a real await, which guarantees React gets a render in
// between "payment succeeded" and "booking confirmed" — the two states
// can no longer be coalesced into one paint, because they're no longer
// simultaneous.
export function BookingPaymentStep({ bookingId, onConfirmed }: Props) {
  const { data: booking, isLoading, refetch } = useBooking(bookingId)

  async function handlePaymentSettled(payment: PublicPayment) {
    if (payment.status !== "SUCCEEDED") return;
    const result = await refetch();
    if (result.data?.status === "CONFIRMED") {
      onConfirmed(result.data);
    }
  }

  if (isLoading || !booking) {
    return <p className="text-sm text-muted-foreground">Loading booking…</p>
  }

  return (
    <PaymentPanel
      bookingId={bookingId}
      amountMinor={booking.priceMinor}
      currency={booking.currency}
      onSettled={handlePaymentSettled}
    />
  )
}

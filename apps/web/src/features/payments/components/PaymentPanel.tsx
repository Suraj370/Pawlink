import { useState } from "react"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/api/errors"
import { priceMinorToMajor } from "@/features/services/money"
import { useBookingPayment, useCreatePayment } from "../hooks"
import type { PaymentScenario, PublicPayment } from "../schemas"

type Props = {
  bookingId: string
  amountMinor: number
  currency: string
  onSettled?: (payment: PublicPayment) => void
}

// This whole panel exists to make one thing visually unmistakable: the
// SERVER decides when a booking becomes CONFIRMED, never the browser. No
// code path in this component sets a booking's status directly — it only
// ever triggers a payment attempt and then reflects back whatever the
// server's payment/booking state actually is (via the query it refetches
// after mutating), including while that state is still PENDING.
export function PaymentPanel({ bookingId, amountMinor, currency, onSettled }: Props) {
  const { data: payment, isLoading, refetch, isFetching } = useBookingPayment(bookingId)
  const createPayment = useCreatePayment(bookingId)
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const [error, setError] = useState<string | null>(null)

  async function pay(scenario: PaymentScenario) {
    setError(null)
    try {
      const result = await createPayment.mutateAsync({ input: { scenario }, idempotencyKey })
      onSettled?.(result)
    } catch (err) {
      setError(await toErrorMessage(err, "Could not process payment"))
    }
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading payment status…</p>
  }

  const status = payment?.status

  return (
    <div className="flex flex-col gap-3 rounded border border-border p-4" data-testid="payment-panel">
      <div className="flex items-center justify-between">
        <h4 className="font-medium">Payment</h4>
        <span className="rounded bg-muted px-2 py-0.5 text-xs uppercase text-muted-foreground">Mock provider — development only</span>
      </div>
      <p className="text-sm text-muted-foreground">
        Amount due: {currency} {priceMinorToMajor(amountMinor)}
      </p>

      {!status && (
        <>
          <p className="text-sm" data-testid="payment-status-required">
            Payment required to confirm this booking.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onPress={() => pay("SUCCESS")} isDisabled={createPayment.isPending} data-testid="pay-success-button">
              {createPayment.isPending ? "Processing…" : "Pay now"}
            </Button>
            <Button
              variant="outline"
              onPress={() => pay("PENDING")}
              isDisabled={createPayment.isPending}
              data-testid="pay-pending-button"
            >
              Simulate: still processing
            </Button>
            <Button
              variant="outline"
              onPress={() => pay("FAILURE")}
              isDisabled={createPayment.isPending}
              data-testid="pay-failure-button"
            >
              Simulate: payment fails
            </Button>
          </div>
        </>
      )}

      {status === "SUCCEEDED" && (
        <p className="text-sm font-medium text-green-700" data-testid="payment-status-succeeded">
          Payment successful.
        </p>
      )}

      {status === "FAILED" && (
        <div className="flex flex-col gap-2" data-testid="payment-status-failed">
          <p className="text-sm font-medium text-destructive">
            Payment failed{payment?.failureMessage ? `: ${payment.failureMessage}` : "."}
          </p>
          <p className="text-sm text-muted-foreground">This booking was not confirmed and has been cancelled.</p>
        </div>
      )}

      {status === "PENDING" && (
        <div className="flex flex-col gap-2" data-testid="payment-status-pending">
          <p className="text-sm">Payment processing — this booking is not confirmed yet.</p>
          <Button variant="ghost" size="sm" onPress={() => void refetch()} isDisabled={isFetching} className="w-fit">
            {isFetching ? "Checking…" : "Check again"}
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid="payment-error">
          {error}
        </p>
      )}
    </div>
  )
}

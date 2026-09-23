import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Pagination } from "@/features/admin/components/Pagination"
import { useAdminPayments } from "@/features/admin/hooks"
import { priceMinorToMajor } from "@/features/services/money"

export const Route = createFileRoute("/_authenticated/admin/payments")({
  component: AdminPaymentsPage,
})

const PAYMENT_STATUS_VALUES = ["CREATED", "PENDING", "SUCCEEDED", "FAILED", "CANCELLED"] as const
const PAGE_SIZE = 20

function AdminPaymentsPage() {
  const [status, setStatus] = useState<(typeof PAYMENT_STATUS_VALUES)[number] | "">("")
  const [page, setPage] = useState(1)
  const { data, isLoading, isError } = useAdminPayments({ status: status || undefined, page, pageSize: PAGE_SIZE })

  return (
    <section className="flex flex-col gap-4" data-testid="admin-payments-page">
      <select
        value={status}
        onChange={(e) => {
          setStatus(e.target.value as typeof status)
          setPage(1)
        }}
        className="rounded border border-border bg-background px-3 py-2 text-sm"
      >
        <option value="">All statuses</option>
        {PAYMENT_STATUS_VALUES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      {isLoading && <p className="text-sm text-muted-foreground">Loading payments…</p>}
      {isError && <p className="text-sm text-destructive">Could not load payments.</p>}

      {data && (
        <>
          <ul className="flex flex-col gap-2" data-testid="admin-payments-list">
            {data.payments.map((payment) => (
              <li key={payment.id} className="rounded border border-border p-3 text-sm" data-testid="admin-payment-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {payment.currency} {priceMinorToMajor(payment.amountMinor)}
                  </span>
                  <span className="text-muted-foreground">{payment.status}</span>
                </div>
                <p className="text-muted-foreground">
                  Booking {payment.bookingId.slice(0, 8)}… · {payment.provider}
                  {payment.providerPaymentId ? ` · ref ${payment.providerPaymentId}` : ""}
                </p>
                {payment.failureMessage && <p className="text-destructive">{payment.failureMessage}</p>}
              </li>
            ))}
          </ul>
          {data.payments.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="admin-payments-empty-state">
              No payments match this filter.
            </p>
          )}
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
        </>
      )}
    </section>
  )
}

import { createFileRoute } from "@tanstack/react-router"
import { useAdminDashboard } from "@/features/admin/hooks"

export const Route = createFileRoute("/_authenticated/admin/")({
  component: AdminDashboardPage,
})

const CARDS: { key: keyof NonNullable<ReturnType<typeof useAdminDashboard>["data"]>; label: string }[] = [
  { key: "totalCustomers", label: "Total customers" },
  { key: "totalProviders", label: "Total providers" },
  { key: "activeProviders", label: "Active providers" },
  { key: "suspendedProviders", label: "Suspended providers" },
  { key: "upcomingBookings", label: "Upcoming bookings" },
  { key: "pendingPayments", label: "Pending payments" },
  { key: "completedBookings", label: "Completed bookings" },
  { key: "reviewCount", label: "Reviews" },
]

function AdminDashboardPage() {
  const { data, isLoading, isError } = useAdminDashboard()

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading dashboard…</p>
  if (isError || !data) return <p className="text-sm text-destructive">Could not load the dashboard.</p>

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4" data-testid="admin-dashboard">
      {CARDS.map((card) => (
        <div key={card.key} className="rounded border border-border p-4" data-testid={`admin-metric-${card.key}`}>
          <p className="text-2xl font-semibold">{data[card.key]}</p>
          <p className="text-sm text-muted-foreground">{card.label}</p>
        </div>
      ))}
    </div>
  )
}

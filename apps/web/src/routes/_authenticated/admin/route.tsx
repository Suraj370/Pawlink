import { Link, Outlet, createFileRoute, redirect } from "@tanstack/react-router"

// Frontend route protection here is UX only, never authorization — every
// /api/admin/* endpoint independently enforces role === "ADMIN" itself
// (see apps/api/src/middleware/auth.ts's createRequireAdmin). A non-admin
// who bypasses this redirect entirely (e.g. by calling the API directly)
// still gets a 403 from the server, not data. See
// docs/architecture.md, "Admin & operations."
export const Route = createFileRoute("/_authenticated/admin")({
  beforeLoad: ({ context }) => {
    if (context.user.role !== "ADMIN") {
      throw redirect({ to: "/dashboard" })
    }
  },
  component: AdminLayout,
})

const NAV_ITEMS = [
  { to: "/admin", label: "Dashboard" },
  { to: "/admin/providers", label: "Providers" },
  { to: "/admin/users", label: "Users" },
  { to: "/admin/bookings", label: "Bookings" },
  { to: "/admin/payments", label: "Payments" },
  { to: "/admin/reviews", label: "Reviews" },
  { to: "/admin/audit", label: "Audit Log" },
] as const

function AdminLayout() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Admin</h1>
        <Link to="/dashboard" className="text-sm underline underline-offset-4">
          Back to Dashboard
        </Link>
      </div>
      <nav className="flex flex-wrap gap-4 border-b border-border pb-3" data-testid="admin-nav">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="text-sm underline-offset-4 hover:underline [&.active]:font-semibold [&.active]:underline"
            activeOptions={{ exact: item.to === "/admin" }}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}

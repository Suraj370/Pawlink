import { createFileRoute, Link } from "@tanstack/react-router"
import { CalendarDays, PawPrint, ShieldCheck, Stethoscope } from "lucide-react"
import { useCurrentUser } from "@/features/auth/hooks"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
})

function DashboardPage() {
  const { data: user } = useCurrentUser()

  const quickLinks = [
    { to: "/pets" as const, label: "My Pets", description: "Manage your pets' profiles", icon: PawPrint },
    { to: "/providers" as const, label: "Providers", description: "Find and book care", icon: Stethoscope },
    { to: "/bookings" as const, label: "My Bookings", description: "See upcoming and past visits", icon: CalendarDays },
    ...(user?.role === "ADMIN"
      ? [
          {
            to: "/admin" as const,
            label: "Admin",
            description: "Review providers, users, and audit logs",
            icon: ShieldCheck,
            testId: "admin-nav-link",
          },
        ]
      : []),
  ]

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-10 sm:px-8">
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-medium text-foreground">Dashboard</h1>
        <p className="text-muted-foreground" data-testid="welcome-message">
          Welcome, {user?.name}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {quickLinks.map((link) => (
          <Link key={link.label} to={link.to} data-testid={link.testId} className="group">
            <Card className="h-full gap-3 transition-shadow hover:shadow-md">
              <span className="flex size-9 items-center justify-center rounded-full bg-accent text-accent-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                <link.icon className="size-4.5" />
              </span>
              <CardContent className="gap-1 p-0">
                <h2 className="font-heading text-base font-semibold text-foreground">{link.label}</h2>
                <p className="text-sm text-muted-foreground">{link.description}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <Card>
        <CardContent className="gap-3 p-0">
          <h2 className="font-heading text-base font-semibold text-foreground">Account</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Email</dt>
            <dd>{user?.email}</dd>
            <dt className="text-muted-foreground">Role</dt>
            <dd>
              <Badge variant="primary">{user?.role}</Badge>
            </dd>
          </dl>
        </CardContent>
      </Card>
    </main>
  )
}

import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { useCurrentUser, useLogout } from "@/features/auth/hooks"

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
})

function DashboardPage() {
  const navigate = useNavigate()
  const { data: user } = useCurrentUser()
  const logout = useLogout()

  async function handleLogout() {
    await logout.mutateAsync()
    navigate({ to: "/login" })
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div>
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-muted-foreground" data-testid="welcome-message">
          Welcome, {user?.name}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Email</dt>
        <dd>{user?.email}</dd>
        <dt className="text-muted-foreground">Role</dt>
        <dd>{user?.role}</dd>
      </dl>
      <Button onClick={handleLogout} isDisabled={logout.isPending} className="w-fit">
        {logout.isPending ? "Logging out…" : "Log out"}
      </Button>
    </main>
  )
}

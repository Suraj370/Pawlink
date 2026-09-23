import { Link, useNavigate } from "@tanstack/react-router"
import { PawPrint } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { useCurrentUser, useLogout } from "@/features/auth/hooks"

export function SiteHeader() {
  const { data: user } = useCurrentUser()
  const logout = useLogout()
  const navigate = useNavigate()

  async function handleLogout() {
    await logout.mutateAsync()
    navigate({ to: "/login" })
  }

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-8">
        <Link to="/" className="flex items-center gap-2 font-heading text-lg font-semibold text-foreground">
          <span className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <PawPrint className="size-4" />
          </span>
          PawLink
        </Link>

        <nav className="hidden items-center gap-6 text-sm font-medium text-muted-foreground sm:flex">
          <Link
            to="/providers"
            className="transition-colors hover:text-foreground"
            activeProps={{ className: "text-foreground" }}
          >
            Find care
          </Link>
          {user && (
            <Link
              to="/dashboard"
              className="transition-colors hover:text-foreground"
              activeProps={{ className: "text-foreground" }}
            >
              Dashboard
            </Link>
          )}
        </nav>

        <div className="flex items-center gap-3">
          {user ? (
            <>
              <Link to="/dashboard" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                {user.name}
              </Link>
              <Button variant="outline" size="sm" onPress={handleLogout} isDisabled={logout.isPending}>
                {logout.isPending ? "Logging out…" : "Log out"}
              </Button>
            </>
          ) : (
            <>
              <Link to="/login" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Log in
              </Link>
              <Link to="/register" className={buttonVariants({ variant: "default", size: "sm" })}>
                Sign up
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  )
}

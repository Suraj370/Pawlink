import { Link, createFileRoute } from "@tanstack/react-router"
import { useApiHealth } from "@/features/system/hooks"

export const Route = createFileRoute("/")({
  component: HomePage,
})

function HomePage() {
  const health = useApiHealth()

  const status = health.isLoading ? "checking" : health.isError ? "offline" : "online"

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold">PawLink</h1>
        <p className="text-muted-foreground">This platform is under development.</p>
      </div>

      <p data-testid="api-status" className="font-mono text-sm text-muted-foreground">
        API status: {status}
      </p>

      <nav className="flex gap-4 text-sm">
        <Link to="/login" className="underline underline-offset-4">
          Log in
        </Link>
        <Link to="/register" className="underline underline-offset-4">
          Register
        </Link>
        <Link to="/providers" className="underline underline-offset-4">
          Browse Providers
        </Link>
      </nav>
    </main>
  )
}

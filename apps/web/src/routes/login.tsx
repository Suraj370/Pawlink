import { Link, createFileRoute, useNavigate, redirect } from "@tanstack/react-router"
import { authMeQueryOptions } from "@/features/auth/api"
import { LoginForm } from "@/features/auth/components/LoginForm"

export const Route = createFileRoute("/login")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient
      .ensureQueryData(authMeQueryOptions)
      .catch(() => null)
    if (user) {
      throw redirect({ to: "/dashboard" })
    }
  },
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 p-8">
      <div>
        <h1 className="text-xl font-semibold">Log in to PawLink</h1>
      </div>
      <LoginForm onSuccess={() => navigate({ to: "/dashboard" })} />
      <p className="text-sm text-muted-foreground">
        Need an account?{" "}
        <Link to="/register" className="underline underline-offset-4">
          Register
        </Link>
      </p>
    </main>
  )
}

import { Link, createFileRoute, useNavigate, redirect } from "@tanstack/react-router"
import { authMeQueryOptions } from "@/features/auth/api"
import { LoginForm } from "@/features/auth/components/LoginForm"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

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
    <main className="mx-auto flex min-h-[calc(100svh-4rem)] max-w-sm flex-col justify-center px-4 py-12">
      <Card className="shadow-md">
        <CardHeader>
          <CardTitle className="font-heading text-xl">Welcome back</CardTitle>
          <CardDescription>Log in to manage your bookings and pets.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm onSuccess={() => navigate({ to: "/dashboard" })} />
          <p className="text-center text-sm text-muted-foreground">
            Need an account?{" "}
            <Link to="/register" className="font-medium text-primary underline-offset-4 hover:underline">
              Register
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  )
}

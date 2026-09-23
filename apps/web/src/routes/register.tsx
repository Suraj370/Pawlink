import { Link, createFileRoute, useNavigate, redirect } from "@tanstack/react-router"
import { authMeQueryOptions } from "@/features/auth/api"
import { RegisterForm } from "@/features/auth/components/RegisterForm"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

export const Route = createFileRoute("/register")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient
      .ensureQueryData(authMeQueryOptions)
      .catch(() => null)
    if (user) {
      throw redirect({ to: "/dashboard" })
    }
  },
  component: RegisterPage,
})

function RegisterPage() {
  const navigate = useNavigate()

  return (
    <main className="mx-auto flex min-h-[calc(100svh-4rem)] max-w-sm flex-col justify-center px-4 py-12">
      <Card className="shadow-md">
        <CardHeader>
          <CardTitle className="font-heading text-xl">Create your account</CardTitle>
          <CardDescription>Book care and keep track of your pets in one place.</CardDescription>
        </CardHeader>
        <CardContent>
          <RegisterForm onSuccess={() => navigate({ to: "/dashboard" })} />
          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">
              Log in
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  )
}

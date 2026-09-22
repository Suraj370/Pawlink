import { Link, createFileRoute, useNavigate, redirect } from "@tanstack/react-router"
import { authMeQueryOptions } from "@/features/auth/api"
import { RegisterForm } from "@/features/auth/components/RegisterForm"

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
    <main className="mx-auto flex max-w-sm flex-col gap-6 p-8">
      <div>
        <h1 className="text-xl font-semibold">Create your PawLink account</h1>
      </div>
      <RegisterForm onSuccess={() => navigate({ to: "/dashboard" })} />
      <p className="text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link to="/login" className="underline underline-offset-4">
          Log in
        </Link>
      </p>
    </main>
  )
}

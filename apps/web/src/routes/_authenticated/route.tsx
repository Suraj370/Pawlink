import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"
import { authMeQueryOptions } from "@/features/auth/api"

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient
      .ensureQueryData(authMeQueryOptions)
      .catch(() => null)

    if (!user) {
      throw redirect({
        to: "/login",
        search: { redirect: location.href },
      })
    }

    return { user }
  },
  component: () => <Outlet />,
})

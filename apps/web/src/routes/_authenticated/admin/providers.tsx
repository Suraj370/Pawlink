import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/api/errors"
import { Pagination } from "@/features/admin/components/Pagination"
import { useAdminProviders, useSetAdminProviderStatus } from "@/features/admin/hooks"

export const Route = createFileRoute("/_authenticated/admin/providers")({
  component: AdminProvidersPage,
})

const PROVIDER_STATUS_VALUES = ["ACTIVE", "INACTIVE", "SUSPENDED"] as const
const PAGE_SIZE = 20

function AdminProvidersPage() {
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState<(typeof PROVIDER_STATUS_VALUES)[number] | "">("")
  const [page, setPage] = useState(1)
  const { data, isLoading, isError } = useAdminProviders({
    search: search || undefined,
    status: status || undefined,
    page,
    pageSize: PAGE_SIZE,
  })
  const setStatusMutation = useSetAdminProviderStatus()
  const [error, setError] = useState<string | null>(null)

  async function handleStatusChange(id: string, newStatus: string) {
    setError(null)
    try {
      await setStatusMutation.mutateAsync({ id, status: newStatus })
    } catch (err) {
      setError(await toErrorMessage(err, "Could not change provider status"))
    }
  }

  return (
    <section className="flex flex-col gap-4" data-testid="admin-providers-page">
      <div className="flex flex-wrap gap-3">
        <input
          type="text"
          placeholder="Search by business name…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          data-testid="admin-provider-search"
        />
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as typeof status)
            setPage(1)
          }}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="">All statuses</option>
          {PROVIDER_STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading providers…</p>}
      {isError && <p className="text-sm text-destructive">Could not load providers.</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {data && (
        <>
          <ul className="flex flex-col gap-2" data-testid="admin-providers-list">
            {data.providers.map((provider) => (
              <li
                key={provider.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-3"
                data-testid="admin-provider-row"
              >
                <div>
                  <p className="font-medium">{provider.businessName}</p>
                  <p className="text-sm text-muted-foreground">
                    {provider.providerType} · {provider.status} ·{" "}
                    {provider.averageRating !== null ? `${provider.averageRating.toFixed(2)} ★` : "No ratings"} (
                    {provider.reviewCount})
                  </p>
                </div>
                <div className="flex gap-2">
                  {PROVIDER_STATUS_VALUES.filter((s) => s !== provider.status).map((s) => (
                    <Button
                      key={s}
                      size="sm"
                      variant={s === "SUSPENDED" ? "destructive" : "outline"}
                      isDisabled={setStatusMutation.isPending}
                      onPress={() => handleStatusChange(provider.id, s)}
                      data-testid={`admin-provider-set-${s}`}
                    >
                      Set {s}
                    </Button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {data.providers.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="admin-providers-empty-state">
              No providers match this filter.
            </p>
          )}
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
        </>
      )}
    </section>
  )
}

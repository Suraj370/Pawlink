import { useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { useCurrentUser } from "@/features/auth/hooks"
import { PROVIDER_TYPE_VALUES } from "@/features/providers/schemas"
import { ProviderForm } from "@/features/providers/components/ProviderForm"
import { useCreateProvider, useProviders } from "@/features/providers/hooks"
import type { ProviderType } from "@/features/providers/schemas"

export const Route = createFileRoute("/providers/")({
  component: ProvidersPage,
})

const PAGE_SIZE = 10

function ProvidersPage() {
  const { data: currentUser } = useCurrentUser()
  const [providerType, setProviderType] = useState<ProviderType | "">("")
  const [city, setCity] = useState("")
  const [page, setPage] = useState(1)
  const [showForm, setShowForm] = useState(false)

  const filters = {
    providerType: providerType || undefined,
    city: city || undefined,
    page,
    pageSize: PAGE_SIZE,
  }
  const { data, isLoading, isError } = useProviders(filters)
  const createProvider = useCreateProvider()

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Providers</h1>
        {currentUser ? (
          <Button onPress={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "Add Provider"}</Button>
        ) : (
          <Link to="/login" className="text-sm underline underline-offset-4">
            Log in to list your business
          </Link>
        )}
      </div>

      {showForm && (
        <div className="rounded border border-border p-4">
          <ProviderForm
            submitLabel="Add Provider"
            pending={createProvider.isPending}
            onSubmit={async (input) => {
              await createProvider.mutateAsync(input)
              setShowForm(false)
            }}
            onCancel={() => setShowForm(false)}
          />
        </div>
      )}

      <div className="flex gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Type
          <select
            value={providerType}
            onChange={(e) => {
              setProviderType(e.target.value as ProviderType | "")
              setPage(1)
            }}
            className="rounded border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">All types</option>
            {PROVIDER_TYPE_VALUES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          City
          <input
            type="text"
            value={city}
            onChange={(e) => {
              setCity(e.target.value)
              setPage(1)
            }}
            className="rounded border border-border bg-background px-3 py-2 text-sm"
            placeholder="Springfield"
          />
        </label>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading providers…</p>}
      {isError && <p className="text-sm text-destructive">Could not load providers.</p>}

      {data && data.providers.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="providers-empty-state">
          No providers match your filters.
        </p>
      )}

      {data && data.providers.length > 0 && (
        <ul className="flex flex-col gap-3" data-testid="providers-list">
          {data.providers.map((provider) => (
            <li key={provider.id} className="rounded border border-border p-4">
              <Link to="/providers/$providerId" params={{ providerId: provider.id }} className="flex flex-col gap-1">
                <span className="font-medium" data-testid="provider-name">
                  {provider.businessName}
                </span>
                <span className="text-sm text-muted-foreground">
                  {provider.providerType}
                  {provider.city ? ` · ${provider.city}` : ""}
                </span>
                {provider.description && (
                  <span className="text-sm text-muted-foreground">{provider.description}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {data && data.total > data.pageSize && (
        <div className="flex items-center gap-3">
          <Button variant="outline" isDisabled={page <= 1} onPress={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button variant="outline" isDisabled={page >= totalPages} onPress={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      )}
    </main>
  )
}

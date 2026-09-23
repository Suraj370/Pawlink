import { useMemo, useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { MapPin, Search, Star } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input, Label } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { useCurrentUser } from "@/features/auth/hooks"
import { PROVIDER_TYPE_VALUES } from "@/features/providers/schemas"
import { PROVIDER_TYPE_META } from "@/features/providers/constants"
import { ProviderAvatar } from "@/features/providers/components/ProviderAvatar"
import { ProviderForm } from "@/features/providers/components/ProviderForm"
import { useCreateProvider, useProviders } from "@/features/providers/hooks"
import type { ProviderType } from "@/features/providers/schemas"

const searchSchema = z.object({
  type: z.enum(PROVIDER_TYPE_VALUES).optional().catch(undefined),
  city: z.string().optional().catch(undefined),
})

export const Route = createFileRoute("/providers/")({
  validateSearch: searchSchema,
  component: ProvidersPage,
})

const PAGE_SIZE = 12
const MIN_RATINGS = [4, 3, 2] as const

function ProvidersPage() {
  const search = Route.useSearch()
  const { data: currentUser } = useCurrentUser()
  const [providerType, setProviderType] = useState<ProviderType | "">(search.type ?? "")
  const [city, setCity] = useState(search.city ?? "")
  const [minRating, setMinRating] = useState<number | null>(null)
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

  // Rating is a client-side refinement of the current page only — the API
  // has no minimum-rating query param, so this deliberately doesn't claim
  // to filter across the whole result set, just what's already loaded.
  const visibleProviders = useMemo(() => {
    if (!data) return []
    if (minRating === null) return data.providers
    return data.providers.filter((p) => (p.averageRating ?? 0) >= minRating)
  }, [data, minRating])

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-medium text-foreground">Find providers</h1>
          <p className="text-sm text-muted-foreground">Vets, groomers, boarding, and pet shops taking bookings.</p>
        </div>
        {currentUser ? (
          <Button onPress={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "Add Provider"}</Button>
        ) : (
          <Link to="/login" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            Log in to list your business
          </Link>
        )}
      </div>

      <Card className="flex-row flex-wrap items-end gap-4 py-4">
        <Label className="min-w-[10rem] flex-1">
          City
          <Input
            type="text"
            value={city}
            onChange={(e) => {
              setCity(e.target.value)
              setPage(1)
            }}
            placeholder="Springfield"
          />
        </Label>
        <Button
          className="h-10"
          onPress={() => setPage(1)}
        >
          <Search className="size-4" data-icon="inline-start" />
          Search
        </Button>
      </Card>

      {showForm && (
        <Card>
          <ProviderForm
            submitLabel="Add Provider"
            pending={createProvider.isPending}
            onSubmit={async (input) => {
              await createProvider.mutateAsync(input)
              setShowForm(false)
            }}
            onCancel={() => setShowForm(false)}
          />
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[16rem_1fr]">
        <aside className="flex flex-col gap-6">
          <Card className="gap-3">
       
            <div className="flex flex-col gap-1">
              {PROVIDER_TYPE_VALUES.map((value) => {
                const meta = PROVIDER_TYPE_META[value]
                const active = providerType === value
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setProviderType(active ? "" : value)
                      setPage(1)
                    }}
                    className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                      active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    <meta.icon className="size-3.5 shrink-0" />
                    {meta.plural}
                  </button>
                )
              })}
            </div>
          </Card>

          <Card className="gap-3">
            <h2 className="text-sm font-semibold text-foreground">Minimum rating</h2>
            <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Minimum rating">
              <button
                type="button"
                role="radio"
                aria-checked={minRating === null}
                onClick={() => setMinRating(null)}
                className={`rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                  minRating === null ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                Any rating
              </button>
              {MIN_RATINGS.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={minRating === r}
                  onClick={() => setMinRating(r)}
                  className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                    minRating === r ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  <Star className="size-3.5 fill-primary text-primary" />
                  {r}+ stars
                </button>
              ))}
            </div>
          </Card>
        </aside>

        <div className="flex flex-col gap-4">
          {isLoading && <p className="text-sm text-muted-foreground">Loading providers…</p>}
          {isError && <p className="text-sm text-destructive">Could not load providers.</p>}

          {data && data.providers.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="providers-empty-state">
              No providers match your filters.
            </p>
          )}

          {data && data.providers.length > 0 && visibleProviders.length === 0 && (
            <p className="text-sm text-muted-foreground">No providers match this rating filter on the current page.</p>
          )}

          {visibleProviders.length > 0 && (
            <ul className="flex flex-col gap-3" data-testid="providers-list">
              {visibleProviders.map((provider) => (
                <li key={provider.id}>
                  <Link to="/providers/$providerId" params={{ providerId: provider.id }}>
                    <Card className="flex-row items-center gap-4 transition-shadow hover:shadow-md">
                      <ProviderAvatar id={provider.id} providerType={provider.providerType} className="size-16" />
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-heading font-semibold text-foreground" data-testid="provider-name">
                            {provider.businessName}
                          </span>
                          {provider.averageRating !== null ? (
                            <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-foreground">
                              <Star className="size-3.5 fill-primary text-primary" />
                              {provider.averageRating.toFixed(1)}
                              <span className="text-muted-foreground">({provider.reviewCount})</span>
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">No ratings yet</span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="muted">{PROVIDER_TYPE_META[provider.providerType].label}</Badge>
                          {provider.city && (
                            <span className="flex items-center gap-1 text-sm text-muted-foreground">
                              <MapPin className="size-3.5" />
                              {provider.city}
                            </span>
                          )}
                        </div>
                        {provider.description && (
                          <p className="line-clamp-1 text-sm text-muted-foreground">{provider.description}</p>
                        )}
                      </div>
                      <span
                        className={buttonVariants({ variant: "outline", size: "sm", className: "hidden shrink-0 sm:flex" })}
                      >
                        View profile
                      </span>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {data && data.total > data.pageSize && (
            <div className="flex items-center gap-3 pt-2">
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
        </div>
      </div>
    </main>
  )
}

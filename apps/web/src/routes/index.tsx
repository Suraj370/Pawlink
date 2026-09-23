import { useState } from "react"
import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { CalendarCheck, HeartPulse, MapPin, PawPrint, Search, ShieldCheck, Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { PROVIDER_TYPE_VALUES } from "@/features/providers/schemas"
import { PROVIDER_TYPE_META } from "@/features/providers/constants"
import { ProviderAvatar } from "@/features/providers/components/ProviderAvatar"
import { useProviders } from "@/features/providers/hooks"
import { useApiHealth } from "@/features/system/hooks"

export const Route = createFileRoute("/")({
  component: HomePage,
})

const TRUST_ITEMS = ["Verified providers", "Live availability", "Secure payments", "Shared medical history"]

const FEATURES = [
  {
    icon: CalendarCheck,
    title: "Real-time booking",
    description: "See a provider's actual open slots and book instantly — no back-and-forth calls.",
  },
  {
    icon: HeartPulse,
    title: "Medical history in one place",
    description: "Every visit, vaccination, and note your pet's care team records, all in one timeline.",
  },
  {
    icon: Star,
    title: "Reviews you can trust",
    description: "Ratings only come from customers with a completed booking — no fake reviews.",
  },
  {
    icon: ShieldCheck,
    title: "Built for privacy",
    description: "Your pet's medical records are visible only to you and the provider who treated them.",
  },
]

function HomePage() {
  const health = useApiHealth()
  const status = health.isLoading ? "checking" : health.isError ? "offline" : "online"
  const navigate = useNavigate()
  const [city, setCity] = useState("")

  const { data } = useProviders({ pageSize: 8 })
  const featured = [...(data?.providers ?? [])]
    .sort((a, b) => (b.averageRating ?? 0) - (a.averageRating ?? 0))
    .slice(0, 4)

  function handleSearch(event: React.FormEvent) {
    event.preventDefault()
    navigate({ to: "/providers", search: city ? { city } : {} })
  }

  return (
    <main>
      <section className="border-b border-border/70 bg-secondary/30">
        <div className="mx-auto grid max-w-5xl grid-cols-1 items-center gap-10 px-4 py-16 sm:px-8 lg:grid-cols-2 lg:py-24">
          <div className="flex flex-col gap-6">
            <span className="w-fit rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">
              Pet care, organized
            </span>
            <h1 className="max-w-lg text-4xl font-medium text-foreground sm:text-5xl">
              Trusted care for happier pets
            </h1>
            <p className="max-w-md text-lg text-muted-foreground">
              Find and book vets, groomers, and boarding providers with live availability, secure
              payments, and a medical history that travels with your pet.
            </p>

            <form onSubmit={handleSearch} className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm sm:flex-row sm:items-center">
              <label className="flex flex-1 items-center gap-2 px-2.5 py-1.5 text-sm">
                <MapPin className="size-4 shrink-0 text-muted-foreground" />
                <span className="sr-only">City</span>
                <Input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="City — try Springfield"
                  className="h-8 border-none px-0 shadow-none focus-visible:ring-0"
                />
              </label>
              <Button type="submit" className="h-10 shrink-0 px-5">
                <Search className="size-4" data-icon="inline-start" />
                Search
              </Button>
            </form>

            <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
              {TRUST_ITEMS.map((item) => (
                <span key={item} className="flex items-center gap-1.5">
                  <ShieldCheck className="size-3.5 text-primary" />
                  {item}
                </span>
              ))}
            </div>
            <p data-testid="api-status" className="font-mono text-xs text-muted-foreground/60">
              API status: {status}
            </p>
          </div>

          <div className="relative hidden aspect-square items-center justify-center rounded-3xl bg-linear-to-br from-primary/15 via-accent to-secondary lg:flex">
            <PawPrint className="size-40 text-primary/30" strokeWidth={1} />
            <span className="absolute right-8 top-8 flex items-center gap-1 rounded-full bg-card px-3 py-1.5 text-xs font-medium text-foreground shadow-sm">
              <Star className="size-3.5 fill-primary text-primary" /> 4.9 average rating
            </span>
            <span className="absolute bottom-8 left-8 rounded-full bg-card px-3 py-1.5 text-xs font-medium text-foreground shadow-sm">
              Real-time slots, every provider
            </span>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 py-14 sm:px-8">
        <h2 className="mb-5 font-heading text-xl font-medium text-foreground">Browse by category</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {PROVIDER_TYPE_VALUES.map((value) => {
            const meta = PROVIDER_TYPE_META[value]
            return (
              <a
                key={value}
                href={`/providers?type=${value}`}
                onClick={(e) => {
                  e.preventDefault()
                  navigate({ to: "/providers", search: { type: value } })
                }}
                className="group flex flex-col gap-3 rounded-2xl border border-border bg-card p-5 shadow-sm transition-shadow hover:shadow-md"
              >
                <span className="flex size-10 items-center justify-center rounded-full bg-accent text-accent-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                  <meta.icon className="size-5" />
                </span>
                <span className="font-heading font-semibold text-foreground">{meta.plural}</span>
              </a>
            )
          })}
        </div>
      </section>

      {featured.length > 0 && (
        <section className="mx-auto max-w-5xl px-4 pb-14 sm:px-8">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="font-heading text-xl font-medium text-foreground">Featured providers</h2>
            <a
              href="/providers"
              onClick={(e) => {
                e.preventDefault()
                navigate({ to: "/providers" })
              }}
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              View all →
            </a>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {featured.map((provider) => (
              <a
                key={provider.id}
                href={`/providers/${provider.id}`}
                onClick={(e) => {
                  e.preventDefault()
                  navigate({ to: "/providers/$providerId", params: { providerId: provider.id } })
                }}
              >
                <Card className="gap-3 transition-shadow hover:shadow-md">
                  <ProviderAvatar id={provider.id} providerType={provider.providerType} className="aspect-video w-full" />
                  <CardContent className="gap-1.5 p-0">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-heading font-semibold text-foreground">{provider.businessName}</span>
                      {provider.averageRating !== null && (
                        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-foreground">
                          <Star className="size-3 fill-primary text-primary" />
                          {provider.averageRating.toFixed(1)}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="muted">{PROVIDER_TYPE_META[provider.providerType].label}</Badge>
                      {provider.city && <span className="text-xs text-muted-foreground">{provider.city}</span>}
                    </div>
                  </CardContent>
                </Card>
              </a>
            ))}
          </div>
        </section>
      )}

      <section className="border-t border-border/70 bg-secondary/40">
        <div className="mx-auto grid max-w-5xl grid-cols-1 gap-4 px-4 py-14 sm:grid-cols-2 sm:px-8 lg:grid-cols-4">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="flex flex-col gap-2">
              <span className="flex size-9 items-center justify-center rounded-full bg-card text-primary shadow-sm">
                <feature.icon className="size-4.5" />
              </span>
              <h3 className="font-heading text-base font-semibold text-foreground">{feature.title}</h3>
              <p className="text-sm text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}

import { useState } from "react"
import { HTTPError } from "ky"
import { Link, createFileRoute } from "@tanstack/react-router"
import { Mail, MapPin, Phone, Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ProviderAvatar } from "@/features/providers/components/ProviderAvatar"
import { PROVIDER_TYPE_META } from "@/features/providers/constants"
import { ProviderForm } from "@/features/providers/components/ProviderForm"
import { useDeactivateProvider, useProvider, useUpdateProvider } from "@/features/providers/hooks"
import { ServiceList } from "@/features/services/components/ServiceList"
import { ExceptionsManager } from "@/features/availability/components/ExceptionsManager"
import { SlotPicker } from "@/features/availability/components/SlotPicker"
import { WeeklyRulesManager } from "@/features/availability/components/WeeklyRulesManager"
import { ProviderBookingsPanel } from "@/features/bookings/components/ProviderBookingsPanel"
import { ProviderReviewsList } from "@/features/reviews/components/ProviderReviewsList"
import { useProviderServices } from "@/features/services/hooks"

export const Route = createFileRoute("/providers/$providerId")({
  component: ProviderDetailsPage,
})

function ProviderDetailsPage() {
  const { providerId } = Route.useParams()
  const { data: provider, isLoading, error } = useProvider(providerId)
  const { data: services } = useProviderServices(providerId)
  const hasBookableServices = (services ?? []).some((s) => s.active)
  const updateProvider = useUpdateProvider(providerId)
  const deactivateProvider = useDeactivateProvider()
  const [isEditing, setIsEditing] = useState(false)
  const [deactivateError, setDeactivateError] = useState<string | null>(null)

  const notFound = error instanceof HTTPError && error.response.status === 404

  if (isLoading) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-8">
        <p className="text-sm text-muted-foreground">Loading provider…</p>
      </main>
    )
  }

  if (notFound || !provider) {
    return (
      <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-10 sm:px-8">
        <p className="text-sm text-destructive" data-testid="provider-not-found">
          Provider not found.
        </p>
        <Link to="/providers" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          Back to Providers
        </Link>
      </main>
    )
  }

  async function handleDeactivate() {
    if (!window.confirm(`Deactivate ${provider!.businessName}? It will no longer be publicly listed.`)) return
    setDeactivateError(null)
    try {
      await deactivateProvider.mutateAsync(provider!.id)
    } catch {
      setDeactivateError("Could not deactivate this provider.")
    }
  }

  if (isEditing) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10 sm:px-8">
        <h1 className="mb-6 font-heading text-xl font-semibold text-foreground">Edit {provider.businessName}</h1>
        <Card>
          <ProviderForm
            submitLabel="Save changes"
            pending={updateProvider.isPending}
            initialValues={{
              businessName: provider.businessName,
              providerType: provider.providerType,
              description: provider.description ?? "",
              phone: provider.phone ?? "",
              email: provider.email ?? "",
              address: provider.address ?? "",
              city: provider.city ?? "",
              state: provider.state ?? "",
              postalCode: provider.postalCode ?? "",
              latitude: provider.latitude != null ? String(provider.latitude) : "",
              longitude: provider.longitude != null ? String(provider.longitude) : "",
              timezone: provider.timezone,
            }}
            onSubmit={async (input) => {
              await updateProvider.mutateAsync(input)
              setIsEditing(false)
            }}
            onCancel={() => setIsEditing(false)}
          />
        </Card>
      </main>
    )
  }

  const typeMeta = PROVIDER_TYPE_META[provider.providerType]

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-8">
      <Link to="/providers" className="w-fit text-sm font-medium text-primary underline-offset-4 hover:underline">
        ← Back to Providers
      </Link>

      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <ProviderAvatar id={provider.id} providerType={provider.providerType} className="size-20 shrink-0" />
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="font-heading text-2xl font-medium text-foreground" data-testid="provider-detail-name">
              {provider.businessName}
            </h1>
            {provider.isOwner && <Badge variant="outline" data-testid="provider-status">{provider.status}</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="muted">{typeMeta.label}</Badge>
            {provider.city && (
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <MapPin className="size-3.5" />
                {provider.city}
              </span>
            )}
            <span className="flex items-center gap-1 text-sm text-muted-foreground" data-testid="provider-rating-headline">
              {provider.averageRating !== null ? (
                <>
                  <Star className="size-3.5 fill-primary text-primary" />
                  {provider.averageRating.toFixed(2)}
                </>
              ) : (
                "No ratings yet"
              )}{" "}
              · {provider.reviewCount} review{provider.reviewCount === 1 ? "" : "s"}
            </span>
          </div>
          {provider.isOwner && (
            <div className="flex gap-3 pt-1">
              <Button size="sm" onPress={() => setIsEditing(true)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onPress={handleDeactivate}
                isDisabled={deactivateProvider.isPending || provider.status === "INACTIVE"}
              >
                {provider.status === "INACTIVE"
                  ? "Deactivated"
                  : deactivateProvider.isPending
                    ? "Deactivating…"
                    : "Deactivate"}
              </Button>
            </div>
          )}
          {deactivateError && (
            <p role="alert" className="text-sm text-destructive">
              {deactivateError}
            </p>
          )}
        </div>
      </div>

      <nav className="flex gap-5 overflow-x-auto border-b border-border text-sm font-medium text-muted-foreground">
        <a href="#about" className="border-b-2 border-transparent py-2.5 hover:text-foreground">
          About
        </a>
        <a href="#services" className="border-b-2 border-transparent py-2.5 hover:text-foreground">
          Services
        </a>
        {provider.isOwner && (
          <a href="#availability" className="border-b-2 border-transparent py-2.5 hover:text-foreground">
            Availability
          </a>
        )}
        <a href="#reviews" className="border-b-2 border-transparent py-2.5 hover:text-foreground">
          Reviews
        </a>
      </nav>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-10">
          <section id="about" className="scroll-mt-20">
            <h2 className="mb-3 font-heading text-lg font-semibold text-foreground">About</h2>
            {provider.description && <p className="mb-4 text-sm text-foreground">{provider.description}</p>}
            <Card>
              <CardContent className="grid grid-cols-1 gap-3 p-0 text-sm sm:grid-cols-2">
                <div className="flex items-start gap-2">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    {[provider.address, provider.city, provider.state, provider.postalCode]
                      .filter(Boolean)
                      .join(", ") || "No address on file"}
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <Phone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>{provider.phone ?? "—"}</span>
                </div>
                <div className="flex items-start gap-2">
                  <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>{provider.email ?? "—"}</span>
                </div>
                {provider.isOwner && (
                  <div className="flex items-start gap-2">
                    <span className="text-muted-foreground">Timezone</span>
                    <span data-testid="provider-timezone">{provider.timezone}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </section>

          <section id="services" className="scroll-mt-20">
            <ServiceList providerId={provider.id} isOwner={provider.isOwner} />
          </section>

          {provider.isOwner && (
            <section id="availability" className="scroll-mt-20 flex flex-col gap-6">
              <h2 className="font-heading text-lg font-semibold text-foreground">Availability</h2>
              <WeeklyRulesManager providerId={provider.id} />
              <ExceptionsManager providerId={provider.id} />
              <div className="border-t border-border pt-6">
                <ProviderBookingsPanel providerId={provider.id} />
              </div>
            </section>
          )}

          <section id="reviews" className="scroll-mt-20">
            <ProviderReviewsList providerId={provider.id} />
          </section>
        </div>

        <aside className="lg:sticky lg:top-20 lg:h-fit">
          {hasBookableServices ? (
            <Card className="shadow-sm">
              <SlotPicker providerId={provider.id} />
            </Card>
          ) : (
            <Card className="shadow-sm">
              <p className="text-sm text-muted-foreground">
                {provider.isOwner
                  ? "Add a service to let customers book appointments."
                  : "This provider hasn't added bookable services yet."}
              </p>
            </Card>
          )}
        </aside>
      </div>
    </main>
  )
}

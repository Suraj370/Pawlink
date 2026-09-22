import { useState } from "react"
import { HTTPError } from "ky"
import { Link, createFileRoute } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { ProviderForm } from "@/features/providers/components/ProviderForm"
import { useDeactivateProvider, useProvider, useUpdateProvider } from "@/features/providers/hooks"
import { ServiceList } from "@/features/services/components/ServiceList"
import { ExceptionsManager } from "@/features/availability/components/ExceptionsManager"
import { SlotPicker } from "@/features/availability/components/SlotPicker"
import { WeeklyRulesManager } from "@/features/availability/components/WeeklyRulesManager"

export const Route = createFileRoute("/providers/$providerId")({
  component: ProviderDetailsPage,
})

function ProviderDetailsPage() {
  const { providerId } = Route.useParams()
  const { data: provider, isLoading, error } = useProvider(providerId)
  const updateProvider = useUpdateProvider(providerId)
  const deactivateProvider = useDeactivateProvider()
  const [isEditing, setIsEditing] = useState(false)
  const [deactivateError, setDeactivateError] = useState<string | null>(null)

  const notFound = error instanceof HTTPError && error.response.status === 404

  if (isLoading) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <p className="text-sm text-muted-foreground">Loading provider…</p>
      </main>
    )
  }

  if (notFound || !provider) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
        <p className="text-sm text-destructive" data-testid="provider-not-found">
          Provider not found.
        </p>
        <Link to="/providers" className="text-sm underline underline-offset-4">
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
      <main className="mx-auto max-w-xl p-8">
        <h1 className="mb-6 text-xl font-semibold">Edit {provider.businessName}</h1>
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
      </main>
    )
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div>
        <Link to="/providers" className="text-sm underline underline-offset-4">
          Back to Providers
        </Link>
      </div>
      <div>
        <h1 className="text-xl font-semibold" data-testid="provider-detail-name">
          {provider.businessName}
        </h1>
        <p className="text-sm text-muted-foreground">{provider.providerType}</p>
      </div>
      {provider.description && <p className="text-sm">{provider.description}</p>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {provider.isOwner && (
          <>
            <dt className="text-muted-foreground">Status</dt>
            <dd data-testid="provider-status">{provider.status}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Address</dt>
        <dd>
          {[provider.address, provider.city, provider.state, provider.postalCode].filter(Boolean).join(", ") || "—"}
        </dd>
        <dt className="text-muted-foreground">Phone</dt>
        <dd>{provider.phone ?? "—"}</dd>
        <dt className="text-muted-foreground">Email</dt>
        <dd>{provider.email ?? "—"}</dd>
        {provider.isOwner && (
          <>
            <dt className="text-muted-foreground">Timezone</dt>
            <dd data-testid="provider-timezone">{provider.timezone}</dd>
          </>
        )}
      </dl>
      {deactivateError && (
        <p role="alert" className="text-sm text-destructive">
          {deactivateError}
        </p>
      )}
      {provider.isOwner && (
        <div className="flex gap-3">
          <Button onPress={() => setIsEditing(true)}>Edit</Button>
          <Button
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
      <ServiceList providerId={provider.id} isOwner={provider.isOwner} />
      {provider.isOwner && (
        <div className="flex flex-col gap-6 border-t border-border pt-6">
          <h2 className="text-lg font-semibold">Availability</h2>
          <WeeklyRulesManager providerId={provider.id} />
          <ExceptionsManager providerId={provider.id} />
        </div>
      )}
      <SlotPicker providerId={provider.id} />
    </main>
  )
}

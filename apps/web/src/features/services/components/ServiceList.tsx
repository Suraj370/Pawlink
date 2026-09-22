import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useCreateProviderService, useDeactivateProviderService, useProviderServices, useUpdateProviderService } from "../hooks"
import { priceMinorToMajor } from "../money"
import { ServiceForm } from "./ServiceForm"
import type { PublicService } from "../schemas"

type Props = {
  providerId: string
  isOwner: boolean
}

export function ServiceList({ providerId, isOwner }: Props) {
  const { data: services, isLoading, isError } = useProviderServices(providerId)
  const createService = useCreateProviderService(providerId)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  return (
    <section className="flex flex-col gap-4" data-testid="services-section">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Services</h2>
        {isOwner && (
          <Button onPress={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "Add Service"}</Button>
        )}
      </div>

      {showForm && (
        <div className="rounded border border-border p-4">
          <ServiceForm
            submitLabel="Add Service"
            pending={createService.isPending}
            onSubmit={async (input) => {
              await createService.mutateAsync(input)
              setShowForm(false)
            }}
            onCancel={() => setShowForm(false)}
          />
        </div>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading services…</p>}
      {isError && <p className="text-sm text-destructive">Could not load services.</p>}

      {services && services.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="services-empty-state">
          {isOwner ? "No services yet." : "This provider hasn't listed any services yet."}
        </p>
      )}

      {services && services.length > 0 && (
        <ul className="flex flex-col gap-3" data-testid="services-list">
          {services.map((service) => (
            <ServiceRow
              key={service.id}
              providerId={providerId}
              service={service}
              isOwner={isOwner}
              isEditing={editingId === service.id}
              onEdit={() => setEditingId(service.id)}
              onCancelEdit={() => setEditingId(null)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

type RowProps = {
  providerId: string
  service: PublicService
  isOwner: boolean
  isEditing: boolean
  onEdit: () => void
  onCancelEdit: () => void
}

function ServiceRow({ providerId, service, isOwner, isEditing, onEdit, onCancelEdit }: RowProps) {
  const updateService = useUpdateProviderService(providerId, service.id)
  const deactivateService = useDeactivateProviderService(providerId)

  if (isEditing) {
    return (
      <li className="rounded border border-border p-4">
        <ServiceForm
          submitLabel="Save changes"
          pending={updateService.isPending}
          initialValues={{
            name: service.name,
            description: service.description ?? "",
            durationMinutes: String(service.durationMinutes),
            price: priceMinorToMajor(service.priceMinor),
            currency: service.currency,
          }}
          onSubmit={async (input) => {
            await updateService.mutateAsync(input)
            onCancelEdit()
          }}
          onCancel={onCancelEdit}
        />
      </li>
    )
  }

  async function handleToggleActive() {
    if (service.active) {
      await deactivateService.mutateAsync(service.id)
    } else {
      await updateService.mutateAsync({ active: true })
    }
  }

  return (
    <li className="rounded border border-border p-4" data-testid="service-row">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-medium" data-testid="service-name">
            {service.name}
          </p>
          <p className="text-sm text-muted-foreground" data-testid="service-details">
            {service.durationMinutes} minutes · {service.currency} {priceMinorToMajor(service.priceMinor)}
          </p>
          {service.description && <p className="mt-1 text-sm">{service.description}</p>}
          {isOwner && !service.active && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="service-inactive-badge">
              Inactive
            </p>
          )}
        </div>
        {isOwner && (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" onPress={onEdit}>
              Edit
            </Button>
            <Button
              size="sm"
              variant={service.active ? "destructive" : "outline"}
              onPress={handleToggleActive}
              isDisabled={deactivateService.isPending || updateService.isPending}
            >
              {service.active ? "Deactivate" : "Reactivate"}
            </Button>
          </div>
        )}
      </div>
    </li>
  )
}

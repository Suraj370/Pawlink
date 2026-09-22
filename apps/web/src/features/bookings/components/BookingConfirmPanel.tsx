import { useState } from "react"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/api/errors"
import { usePets } from "@/features/pets/hooks"
import { priceMinorToMajor } from "@/features/services/money"
import type { PublicService } from "@/features/services/schemas"
import { useCreateBooking } from "../hooks"
import { addMinutesToOffsetIso, offsetIsoTime } from "../isoTime"
import type { PublicBooking } from "../schemas"

type Props = {
  providerId: string
  service: PublicService
  slotIso: string
  onCancel: () => void
  onBooked: (booking: PublicBooking) => void
}

// Clicking a slot only opens this review step — the reservation is made
// only once the server confirms POST /api/bookings succeeds.
export function BookingConfirmPanel({ providerId, service, slotIso, onCancel, onBooked }: Props) {
  const { data: pets, isLoading: petsLoading } = usePets()
  const [petId, setPetId] = useState("")
  // Stable for the lifetime of this panel (one review-and-confirm
  // attempt for this specific slot): a retried "Confirm" click after a
  // transient failure reuses it safely; opening a different slot mounts
  // a fresh panel with a new key.
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const createBooking = useCreateBooking()
  const [error, setError] = useState<string | null>(null)

  // Both times are formatted directly from the provider-offset ISO
  // strings the availability endpoint returned — never reinterpreted
  // through the browser's own timezone.
  const endIso = addMinutesToOffsetIso(slotIso, service.durationMinutes)

  async function handleConfirm() {
    if (!petId) {
      setError("Select a pet first")
      return
    }
    setError(null)
    try {
      const booking = await createBooking.mutateAsync({
        input: { providerId, serviceId: service.id, petId, startAt: slotIso },
        idempotencyKey,
      })
      onBooked(booking)
    } catch (err) {
      setError(await toErrorMessage(err, "Could not create this booking"))
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded border border-border p-4" data-testid="booking-confirm-panel">
      <h4 className="font-medium">Review booking</h4>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Service</dt>
        <dd>{service.name}</dd>
        <dt className="text-muted-foreground">Time</dt>
        <dd data-testid="booking-review-time">
          {offsetIsoTime(slotIso)}–{offsetIsoTime(endIso)}
        </dd>
        <dt className="text-muted-foreground">Price</dt>
        <dd>
          {service.currency} {priceMinorToMajor(service.priceMinor)}
        </dd>
      </dl>

      {petsLoading && <p className="text-sm text-muted-foreground">Loading your pets…</p>}
      {pets && pets.length === 0 && (
        <p className="text-sm text-destructive" data-testid="no-pets-message">
          You need to add a pet before booking.
        </p>
      )}
      {pets && pets.length > 0 && (
        <label className="flex flex-col gap-1 text-sm">
          Pet
          <select
            value={petId}
            onChange={(e) => setPetId(e.target.value)}
            className="rounded border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">Select a pet…</option>
            {pets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid="booking-confirm-error">
          {error}
        </p>
      )}

      <div className="flex gap-3">
        <Button onPress={handleConfirm} isDisabled={createBooking.isPending || !petId}>
          {createBooking.isPending ? "Booking…" : "Confirm Booking"}
        </Button>
        <Button type="button" variant="ghost" onPress={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

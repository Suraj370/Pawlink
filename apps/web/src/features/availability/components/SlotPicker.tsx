import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { useProviderServices } from "@/features/services/hooks"
import { BookingConfirmPanel } from "@/features/bookings/components/BookingConfirmPanel"
import type { PublicBooking } from "@/features/bookings/schemas"
import { useAvailability } from "../hooks"

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function SlotPicker({ providerId }: { providerId: string }) {
  const { data: services } = useProviderServices(providerId)
  const activeServices = services?.filter((s) => s.active) ?? []

  const [serviceId, setServiceId] = useState("")
  const [date, setDate] = useState(todayIsoDate())
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null)
  const [confirmedBooking, setConfirmedBooking] = useState<PublicBooking | null>(null)

  const enabled = serviceId !== "" && date !== ""
  const { data, isLoading, isError } = useAvailability(providerId, { date, serviceId }, enabled)
  const selectedService = activeServices.find((s) => s.id === serviceId)

  if (activeServices.length === 0) {
    return null
  }

  function resetSelection() {
    setSelectedSlot(null)
    setConfirmedBooking(null)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="slot-picker">
      <h3 className="font-medium">Check availability</h3>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Service
          <select
            value={serviceId}
            onChange={(e) => {
              setServiceId(e.target.value)
              resetSelection()
            }}
            className="rounded border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">Select a service…</option>
            {activeServices.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.durationMinutes} min)
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Date
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value)
              resetSelection()
            }}
            className="rounded border border-border bg-background px-3 py-2 text-sm"
          />
        </label>
      </div>

      {enabled && isLoading && <p className="text-sm text-muted-foreground">Loading availability…</p>}
      {enabled && isError && <p className="text-sm text-destructive">Could not load availability.</p>}
      {enabled && data && data.slots.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="slots-empty-state">
          No available slots for this date.
        </p>
      )}
      {enabled && data && data.slots.length > 0 && !confirmedBooking && (
        <ul className="flex flex-wrap gap-2" data-testid="slots-list">
          {data.slots.map((slot) => (
            <li key={slot}>
              <Button
                size="sm"
                variant={selectedSlot === slot ? "default" : "outline"}
                onPress={() => setSelectedSlot(slot)}
                data-testid="slot-button"
              >
                {slot.slice(11, 16)}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {selectedSlot && selectedService && !confirmedBooking && (
        <BookingConfirmPanel
          providerId={providerId}
          service={selectedService}
          slotIso={selectedSlot}
          onCancel={() => setSelectedSlot(null)}
          onBooked={(booking) => setConfirmedBooking(booking)}
        />
      )}

      {confirmedBooking && (
        <div className="flex flex-col gap-2 rounded border border-border p-4" data-testid="booking-confirmation">
          <p className="text-sm font-medium">Booking confirmed for {confirmedBooking.startAt.slice(11, 16)}.</p>
          <div className="flex gap-3">
            <Link to="/bookings" className="text-sm underline underline-offset-4">
              View my bookings
            </Link>
            <Button size="sm" variant="ghost" onPress={resetSelection}>
              Book another slot
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useProviderServices } from "@/features/services/hooks"
import { useAvailability } from "../hooks"

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

// Demonstrates that the availability engine produces correct results.
// Clicking a slot does NOT create a booking — that's the next milestone.
export function SlotPicker({ providerId }: { providerId: string }) {
  const { data: services } = useProviderServices(providerId)
  const activeServices = services?.filter((s) => s.active) ?? []

  const [serviceId, setServiceId] = useState("")
  const [date, setDate] = useState(todayIsoDate())
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null)

  const enabled = serviceId !== "" && date !== ""
  const { data, isLoading, isError } = useAvailability(providerId, { date, serviceId }, enabled)

  if (activeServices.length === 0) {
    return null
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
              setSelectedSlot(null)
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
              setSelectedSlot(null)
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
      {enabled && data && data.slots.length > 0 && (
        <ul className="flex flex-wrap gap-2" data-testid="slots-list">
          {data.slots.map((slot) => {
            const timeLabel = slot.slice(11, 16)
            return (
              <li key={slot}>
                <Button
                  size="sm"
                  variant={selectedSlot === slot ? "default" : "outline"}
                  onPress={() => setSelectedSlot(slot)}
                  data-testid="slot-button"
                >
                  {timeLabel}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {selectedSlot && (
        <p className="text-sm text-muted-foreground" data-testid="selected-slot-message">
          Selected {selectedSlot.slice(11, 16)} — booking isn't available yet.
        </p>
      )}
    </div>
  )
}

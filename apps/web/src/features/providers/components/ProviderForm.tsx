import { useState } from "react"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/api/errors"
import { PROVIDER_TYPE_VALUES, createProviderSchema } from "../schemas"
import type { CreateProviderInput } from "../schemas"

export type ProviderFormValues = {
  businessName: string
  providerType: string
  description: string
  phone: string
  email: string
  address: string
  city: string
  state: string
  postalCode: string
  latitude: string
  longitude: string
  timezone: string
}

const EMPTY_VALUES: ProviderFormValues = {
  businessName: "",
  providerType: "VET",
  description: "",
  phone: "",
  email: "",
  address: "",
  city: "",
  state: "",
  postalCode: "",
  latitude: "",
  longitude: "",
  timezone: "UTC",
}

type Props = {
  initialValues?: Partial<ProviderFormValues>
  submitLabel: string
  pending: boolean
  onSubmit: (input: CreateProviderInput) => Promise<void>
  onCancel?: () => void
}

export function ProviderForm({ initialValues, submitLabel, pending, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<ProviderFormValues>({ ...EMPTY_VALUES, ...initialValues })
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  function update<K extends keyof ProviderFormValues>(key: K, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFieldError(null)
    setSubmitError(null)

    // Client-side validation is a UX convenience only — the API
    // independently re-validates every field with the same schema.
    const parsed = createProviderSchema.safeParse(values)
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Invalid input")
      return
    }

    try {
      await onSubmit(parsed.data)
    } catch (err) {
      setSubmitError(await toErrorMessage(err, "Could not save provider"))
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <label className="flex flex-col gap-1 text-sm">
        Business name
        <input
          type="text"
          value={values.businessName}
          onChange={(e) => update("businessName", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Provider type
        <select
          value={values.providerType}
          onChange={(e) => update("providerType", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        >
          {PROVIDER_TYPE_VALUES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Description
        <textarea
          value={values.description}
          onChange={(e) => update("description", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          rows={3}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Phone
        <input
          type="tel"
          value={values.phone}
          onChange={(e) => update("phone", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input
          type="email"
          value={values.email}
          onChange={(e) => update("email", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Address
        <input
          type="text"
          value={values.address}
          onChange={(e) => update("address", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        City
        <input
          type="text"
          value={values.city}
          onChange={(e) => update("city", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        State
        <input
          type="text"
          value={values.state}
          onChange={(e) => update("state", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Postal code
        <input
          type="text"
          value={values.postalCode}
          onChange={(e) => update("postalCode", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Latitude
        <input
          type="number"
          step="any"
          min="-90"
          max="90"
          value={values.latitude}
          onChange={(e) => update("latitude", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Longitude
        <input
          type="number"
          step="any"
          min="-180"
          max="180"
          value={values.longitude}
          onChange={(e) => update("longitude", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Timezone (IANA, e.g. Asia/Kolkata)
        <input
          type="text"
          value={values.timezone}
          onChange={(e) => update("timezone", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          placeholder="Asia/Kolkata"
        />
      </label>
      {(fieldError ?? submitError) && (
        <p role="alert" className="text-sm text-destructive" data-testid="provider-form-error">
          {fieldError ?? submitError}
        </p>
      )}
      <div className="flex gap-3">
        <Button type="submit" isDisabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onPress={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}

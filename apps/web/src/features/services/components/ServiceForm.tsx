import { useState } from "react"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/api/errors"
import { createServiceSchema, DEFAULT_CURRENCY } from "../schemas"
import { priceMajorToMinor } from "../money"
import type { CreateServiceInput } from "../schemas"

export type ServiceFormValues = {
  name: string
  description: string
  durationMinutes: string
  price: string
  currency: string
}

const EMPTY_VALUES: ServiceFormValues = {
  name: "",
  description: "",
  durationMinutes: "",
  price: "",
  currency: DEFAULT_CURRENCY,
}

type Props = {
  initialValues?: Partial<ServiceFormValues>
  submitLabel: string
  pending: boolean
  onSubmit: (input: CreateServiceInput) => Promise<void>
  onCancel?: () => void
}

export function ServiceForm({ initialValues, submitLabel, pending, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<ServiceFormValues>({ ...EMPTY_VALUES, ...initialValues })
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  function update<K extends keyof ServiceFormValues>(key: K, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFieldError(null)
    setSubmitError(null)

    const priceMinor = priceMajorToMinor(values.price)
    if (priceMinor === null || Number.isNaN(priceMinor)) {
      setFieldError("Enter a price like 799 or 799.50")
      return
    }

    // Client-side validation is a UX convenience only — the API
    // independently re-validates every field with the same schema.
    const parsed = createServiceSchema.safeParse({
      name: values.name,
      description: values.description,
      durationMinutes: values.durationMinutes,
      priceMinor,
      currency: values.currency,
    })
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Invalid input")
      return
    }

    try {
      await onSubmit(parsed.data)
    } catch (err) {
      setSubmitError(await toErrorMessage(err, "Could not save service"))
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input
          type="text"
          value={values.name}
          onChange={(e) => update("name", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          required
        />
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
        Duration (minutes)
        <input
          type="number"
          step="1"
          min="1"
          value={values.durationMinutes}
          onChange={(e) => update("durationMinutes", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          required
        />
      </label>
      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          Price
          <input
            type="text"
            inputMode="decimal"
            value={values.price}
            onChange={(e) => update("price", e.target.value)}
            className="rounded border border-border bg-background px-3 py-2 text-sm"
            placeholder="799.00"
            required
          />
        </label>
        <label className="flex w-28 flex-col gap-1 text-sm">
          Currency
          <input
            type="text"
            value={values.currency}
            onChange={(e) => update("currency", e.target.value.toUpperCase())}
            className="rounded border border-border bg-background px-3 py-2 text-sm"
            maxLength={3}
          />
        </label>
      </div>
      {(fieldError ?? submitError) && (
        <p role="alert" className="text-sm text-destructive" data-testid="service-form-error">
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

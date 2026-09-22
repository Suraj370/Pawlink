import { useState } from "react"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/api/errors"
import { PET_SEX_VALUES, createPetSchema } from "../schemas"
import type { CreatePetInput } from "../schemas"

export type PetFormValues = {
  name: string
  species: string
  breed: string
  sex: string
  dateOfBirth: string
  weight: string
  photoUrl: string
}

const EMPTY_VALUES: PetFormValues = {
  name: "",
  species: "",
  breed: "",
  sex: "UNKNOWN",
  dateOfBirth: "",
  weight: "",
  photoUrl: "",
}

type Props = {
  initialValues?: Partial<PetFormValues>
  submitLabel: string
  pending: boolean
  onSubmit: (input: CreatePetInput) => Promise<void>
  onCancel?: () => void
}

export function PetForm({ initialValues, submitLabel, pending, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<PetFormValues>({ ...EMPTY_VALUES, ...initialValues })
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  function update<K extends keyof PetFormValues>(key: K, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFieldError(null)
    setSubmitError(null)

    // Client-side validation is a UX convenience only — the API
    // independently re-validates every field with the same schema.
    const parsed = createPetSchema.safeParse(values)
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Invalid input")
      return
    }

    try {
      await onSubmit(parsed.data)
    } catch (err) {
      setSubmitError(await toErrorMessage(err, "Could not save pet"))
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
        Species
        <input
          type="text"
          value={values.species}
          onChange={(e) => update("species", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          placeholder="Dog, cat, rabbit…"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Breed
        <input
          type="text"
          value={values.breed}
          onChange={(e) => update("breed", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Sex
        <select
          value={values.sex}
          onChange={(e) => update("sex", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        >
          {PET_SEX_VALUES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Date of birth
        <input
          type="date"
          value={values.dateOfBirth}
          onChange={(e) => update("dateOfBirth", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Weight (kg)
        <input
          type="number"
          step="0.1"
          min="0"
          value={values.weight}
          onChange={(e) => update("weight", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Photo URL
        <input
          type="url"
          value={values.photoUrl}
          onChange={(e) => update("photoUrl", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          placeholder="https://…"
        />
      </label>
      {(fieldError ?? submitError) && (
        <p role="alert" className="text-sm text-destructive" data-testid="pet-form-error">
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

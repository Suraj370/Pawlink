import { useState } from "react"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/api/errors"
import { useCreateMedicalRecord } from "../hooks"
import { ALLERGY_SEVERITY_VALUES, MEDICAL_RECORD_TYPE_VALUES, detailsSchemaForType, type MedicalRecordType } from "../schemas"

type FieldValues = {
  title: string
  description: string
  recordedAt: string
  // A superset of every record type's detail fields — only the ones
  // relevant to the currently selected recordType are sent.
  chiefComplaint: string
  observations: string
  diagnosis: string
  treatment: string
  followUpNotes: string
  vaccineName: string
  administeredAt: string
  nextDueAt: string
  medicationName: string
  dosage: string
  frequency: string
  route: string
  duration: string
  instructions: string
  allergen: string
  reaction: string
  severity: string
  testName: string
  result: string
  referenceRange: string
  notes: string
}

const EMPTY: FieldValues = {
  title: "",
  description: "",
  recordedAt: "",
  chiefComplaint: "",
  observations: "",
  diagnosis: "",
  treatment: "",
  followUpNotes: "",
  vaccineName: "",
  administeredAt: "",
  nextDueAt: "",
  medicationName: "",
  dosage: "",
  frequency: "",
  route: "",
  duration: "",
  instructions: "",
  allergen: "",
  reaction: "",
  severity: "",
  testName: "",
  result: "",
  referenceRange: "",
  notes: "",
}

function detailsFor(recordType: MedicalRecordType, v: FieldValues): Record<string, unknown> {
  const trim = (s: string) => s.trim()
  switch (recordType) {
    case "VACCINATION":
      return { vaccineName: trim(v.vaccineName), administeredAt: v.administeredAt, nextDueAt: v.nextDueAt || undefined, notes: trim(v.notes) || undefined };
    case "MEDICATION":
      return {
        medicationName: trim(v.medicationName),
        dosage: trim(v.dosage),
        frequency: trim(v.frequency),
        route: trim(v.route) || undefined,
        duration: trim(v.duration) || undefined,
        instructions: trim(v.instructions) || undefined,
      };
    case "ALLERGY":
      return {
        allergen: trim(v.allergen),
        reaction: trim(v.reaction) || undefined,
        severity: v.severity || undefined,
        notes: trim(v.notes) || undefined,
      };
    case "LAB_RESULT":
      return {
        testName: trim(v.testName),
        result: trim(v.result),
        referenceRange: trim(v.referenceRange) || undefined,
        notes: trim(v.notes) || undefined,
      };
    default:
      return {
        chiefComplaint: trim(v.chiefComplaint) || undefined,
        observations: trim(v.observations) || undefined,
        diagnosis: trim(v.diagnosis) || undefined,
        treatment: trim(v.treatment) || undefined,
        followUpNotes: trim(v.followUpNotes) || undefined,
      };
  }
}

// Provider-only: creating a medical record. The provider/pet relationship
// is re-derived and re-verified on the server for every request — this
// form never sends a providerId the server hasn't already independently
// authorized (see routes/medical-records.ts), it's only ever pre-filled
// here as a convenience when the caller owns more than one eligible
// provider (rare; today providerId is simply omitted and the server picks
// the caller's sole eligible provider).
export function MedicalRecordForm({ petId, onCreated }: { petId: string; onCreated?: () => void }) {
  const [recordType, setRecordType] = useState<MedicalRecordType>("VISIT")
  const [values, setValues] = useState<FieldValues>(EMPTY)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const createRecord = useCreateMedicalRecord(petId)

  function update<K extends keyof FieldValues>(key: K, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFieldError(null)
    setSubmitError(null)

    if (!values.title.trim()) {
      setFieldError("Title is required")
      return
    }
    if (!values.recordedAt) {
      setFieldError("Date is required")
      return
    }

    const details = detailsFor(recordType, values)
    const detailsCheck = detailsSchemaForType(recordType).safeParse(details)
    if (!detailsCheck.success) {
      setFieldError(detailsCheck.error.issues[0]?.message ?? "Invalid details for this record type")
      return
    }

    try {
      await createRecord.mutateAsync({
        recordType,
        title: values.title.trim(),
        description: values.description.trim() || undefined,
        recordedAt: new Date(values.recordedAt).toISOString(),
        details: detailsCheck.data,
      })
      setValues(EMPTY)
      onCreated?.()
    } catch (err) {
      setSubmitError(await toErrorMessage(err, "Could not create medical record"))
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate data-testid="medical-record-form">
      <label className="flex flex-col gap-1 text-sm">
        Record type
        <select
          value={recordType}
          onChange={(e) => setRecordType(e.target.value as MedicalRecordType)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        >
          {MEDICAL_RECORD_TYPE_VALUES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Title
        <input
          type="text"
          value={values.title}
          onChange={(e) => update("title", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Date
        <input
          type="datetime-local"
          value={values.recordedAt}
          onChange={(e) => update("recordedAt", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Summary (optional)
        <textarea
          value={values.description}
          onChange={(e) => update("description", e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          rows={2}
        />
      </label>

      {recordType === "VACCINATION" && (
        <>
          <TextField label="Vaccine name" value={values.vaccineName} onChange={(v) => update("vaccineName", v)} required />
          <label className="flex flex-col gap-1 text-sm">
            Administered on
            <input type="date" value={values.administeredAt} onChange={(e) => update("administeredAt", e.target.value)} className="rounded border border-border bg-background px-3 py-2 text-sm" required />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Next due (optional)
            <input type="date" value={values.nextDueAt} onChange={(e) => update("nextDueAt", e.target.value)} className="rounded border border-border bg-background px-3 py-2 text-sm" />
          </label>
          <TextField label="Notes" value={values.notes} onChange={(v) => update("notes", v)} />
        </>
      )}

      {recordType === "MEDICATION" && (
        <>
          <TextField label="Medication name" value={values.medicationName} onChange={(v) => update("medicationName", v)} required />
          <TextField label="Dosage" value={values.dosage} onChange={(v) => update("dosage", v)} required />
          <TextField label="Frequency" value={values.frequency} onChange={(v) => update("frequency", v)} required />
          <TextField label="Route (optional)" value={values.route} onChange={(v) => update("route", v)} />
          <TextField label="Duration (optional)" value={values.duration} onChange={(v) => update("duration", v)} />
          <TextField label="Instructions (optional)" value={values.instructions} onChange={(v) => update("instructions", v)} />
        </>
      )}

      {recordType === "ALLERGY" && (
        <>
          <TextField label="Allergen" value={values.allergen} onChange={(v) => update("allergen", v)} required />
          <TextField label="Reaction (optional)" value={values.reaction} onChange={(v) => update("reaction", v)} />
          <label className="flex flex-col gap-1 text-sm">
            Severity (optional)
            <select value={values.severity} onChange={(e) => update("severity", e.target.value)} className="rounded border border-border bg-background px-3 py-2 text-sm">
              <option value="">—</option>
              {ALLERGY_SEVERITY_VALUES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <TextField label="Notes (optional)" value={values.notes} onChange={(v) => update("notes", v)} />
        </>
      )}

      {recordType === "LAB_RESULT" && (
        <>
          <TextField label="Test name" value={values.testName} onChange={(v) => update("testName", v)} required />
          <TextField label="Result" value={values.result} onChange={(v) => update("result", v)} required />
          <TextField label="Reference range (optional)" value={values.referenceRange} onChange={(v) => update("referenceRange", v)} />
          <TextField label="Notes (optional)" value={values.notes} onChange={(v) => update("notes", v)} />
        </>
      )}

      {(recordType === "VISIT" || recordType === "DIAGNOSIS" || recordType === "SURGERY" || recordType === "OTHER") && (
        <>
          <TextField label="Chief complaint (optional)" value={values.chiefComplaint} onChange={(v) => update("chiefComplaint", v)} />
          <TextField label="Observations (optional)" value={values.observations} onChange={(v) => update("observations", v)} multiline />
          <TextField label="Diagnosis (optional)" value={values.diagnosis} onChange={(v) => update("diagnosis", v)} />
          <TextField label="Treatment (optional)" value={values.treatment} onChange={(v) => update("treatment", v)} multiline />
          <TextField label="Follow-up notes (optional)" value={values.followUpNotes} onChange={(v) => update("followUpNotes", v)} />
        </>
      )}

      {(fieldError ?? submitError) && (
        <p role="alert" className="text-sm text-destructive" data-testid="medical-record-form-error">
          {fieldError ?? submitError}
        </p>
      )}
      <div>
        <Button type="submit" isDisabled={createRecord.isPending}>
          {createRecord.isPending ? "Saving…" : "Add record"}
        </Button>
      </div>
    </form>
  )
}

function TextField({
  label,
  value,
  onChange,
  required,
  multiline,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
  multiline?: boolean
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          rows={2}
          required={required}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          required={required}
        />
      )}
    </label>
  )
}

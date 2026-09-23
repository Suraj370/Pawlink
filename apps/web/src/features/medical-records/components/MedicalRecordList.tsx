import { useState } from "react"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/api/errors"
import { useArchiveMedicalRecord, useMedicalRecords } from "../hooks"
import { MEDICAL_RECORD_TYPE_VALUES, type MedicalRecordType, type PublicMedicalRecord } from "../schemas"

function detailSummary(record: PublicMedicalRecord): string | null {
  const d = record.details as Record<string, unknown>
  switch (record.recordType) {
    case "VACCINATION":
      return d.vaccineName ? `Vaccine: ${d.vaccineName}${d.nextDueAt ? ` · next due ${d.nextDueAt}` : ""}` : null
    case "MEDICATION":
      return d.medicationName ? `${d.medicationName} — ${d.dosage ?? ""} ${d.frequency ?? ""}`.trim() : null
    case "ALLERGY":
      return d.allergen ? `Allergen: ${d.allergen}${d.severity ? ` (${d.severity})` : ""}` : null
    case "LAB_RESULT":
      return d.testName ? `${d.testName}: ${d.result ?? ""}` : null
    default:
      return typeof d.diagnosis === "string" && d.diagnosis ? `Diagnosis: ${d.diagnosis}` : null
  }
}

// A read-only view for the pet owner, or a management view (with archive)
// for the authoring provider — `canManage` gates the archive action, not
// the read itself (the server independently re-checks authorization on
// every request regardless of what this component renders).
export function MedicalRecordList({
  petId,
  canManage = false,
  currentUserId,
}: {
  petId: string
  canManage?: boolean
  currentUserId?: string
}) {
  const [recordType, setRecordType] = useState<MedicalRecordType | "">("")
  const [includeArchived, setIncludeArchived] = useState(false)
  const { data, isLoading, isError } = useMedicalRecords(petId, {
    recordType: recordType || undefined,
    includeArchived,
  })
  const archiveRecord = useArchiveMedicalRecord()
  const [error, setError] = useState<string | null>(null)

  async function handleArchive(id: string) {
    if (!window.confirm("Archive this record? It will move out of the active history but is never deleted.")) return
    setError(null)
    try {
      await archiveRecord.mutateAsync({ id })
    } catch (err) {
      setError(await toErrorMessage(err, "Could not archive this record"))
    }
  }

  return (
    <section className="flex flex-col gap-3" data-testid="medical-records-list">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Medical Records</h2>
        <div className="flex items-center gap-3 text-sm">
          <select
            value={recordType}
            onChange={(e) => setRecordType(e.target.value as MedicalRecordType | "")}
            className="rounded border border-border bg-background px-2 py-1 text-sm"
            aria-label="Filter by record type"
          >
            <option value="">All types</option>
            {MEDICAL_RECORD_TYPE_VALUES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Include archived
          </label>
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading medical records…</p>}
      {isError && <p className="text-sm text-destructive">Could not load medical records.</p>}
      {data && data.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="medical-records-empty-state">
          No medical records yet.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {data && data.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="medical-records-rows">
          {data.map((record) => {
            const summary = detailSummary(record)
            const isAuthor = currentUserId && record.createdByUserId === currentUserId
            return (
              <li
                key={record.id}
                className="flex flex-col gap-1 rounded border border-border p-3"
                data-testid="medical-record-row"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{record.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {record.recordType} · {record.recordedAt.slice(0, 10)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">By {record.providerName}</p>
                {record.description && <p className="text-sm">{record.description}</p>}
                {summary && <p className="text-sm text-muted-foreground">{summary}</p>}
                {record.status === "ARCHIVED" && (
                  <p className="text-xs italic text-muted-foreground" data-testid="medical-record-archived">
                    Archived{record.archivedReason ? `: ${record.archivedReason}` : ""}
                  </p>
                )}
                {canManage && isAuthor && record.status === "ACTIVE" && (
                  <div className="mt-1">
                    <Button size="sm" variant="destructive" onPress={() => handleArchive(record.id)} isDisabled={archiveRecord.isPending}>
                      Archive
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

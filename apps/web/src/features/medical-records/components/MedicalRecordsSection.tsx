import { useState } from "react"
import { Button } from "@/components/ui/button"
import { MedicalRecordForm } from "./MedicalRecordForm"
import { MedicalRecordList } from "./MedicalRecordList"

// The single mount point used by both the customer's pet page (read only)
// and a provider's eligible-pet page (read + create + archive their own
// records). `canCreate` only toggles the UI — every write still goes
// through the same server-side authorization check regardless of what
// this component lets the user attempt.
export function MedicalRecordsSection({
  petId,
  canCreate = false,
  currentUserId,
}: {
  petId: string
  canCreate?: boolean
  currentUserId?: string
}) {
  const [showForm, setShowForm] = useState(false)

  return (
    <div className="flex flex-col gap-4 border-t border-border pt-6" data-testid="medical-records-section">
      {canCreate && (
        <div>
          <Button size="sm" onPress={() => setShowForm((s) => !s)}>
            {showForm ? "Close" : "Add medical record"}
          </Button>
          {showForm && (
            <div className="mt-3">
              <MedicalRecordForm petId={petId} onCreated={() => setShowForm(false)} />
            </div>
          )}
        </div>
      )}
      <MedicalRecordList petId={petId} canManage={canCreate} currentUserId={currentUserId} />
    </div>
  )
}

import { Link, createFileRoute } from "@tanstack/react-router"
import { useCurrentUser } from "@/features/auth/hooks"
import { MedicalRecordsSection } from "@/features/medical-records/components/MedicalRecordsSection"

// A provider-facing view of one patient's medical history, reached from a
// booking row (see ProviderBookingsPanel). Deliberately keyed by petId
// alone, not providerId — the server derives which of the caller's own
// providers (if any) has a legitimate relationship with this pet from the
// session, exactly as every other medical-record endpoint does; this page
// never asserts or passes a providerId as authoritative. A provider with
// no legitimate relationship to this pet sees the same empty/unauthorized
// result the API returns, never pet details from elsewhere.
export const Route = createFileRoute("/_authenticated/provider-medical-records/$petId")({
  component: ProviderMedicalRecordsPage,
})

function ProviderMedicalRecordsPage() {
  const { petId } = Route.useParams()
  const { data: user } = useCurrentUser()

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div>
        <Link to="/dashboard" className="text-sm underline underline-offset-4">
          Back to Dashboard
        </Link>
      </div>
      <h1 className="text-xl font-semibold">Patient Medical Records</h1>
      <MedicalRecordsSection petId={petId} canCreate currentUserId={user?.id} />
    </main>
  )
}

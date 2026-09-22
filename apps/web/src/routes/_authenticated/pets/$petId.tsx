import { useState } from "react"
import { HTTPError } from "ky"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { PetForm } from "@/features/pets/components/PetForm"
import { useDeletePet, usePet, useUpdatePet } from "@/features/pets/hooks"

export const Route = createFileRoute("/_authenticated/pets/$petId")({
  component: PetDetailsPage,
})

function PetDetailsPage() {
  const { petId } = Route.useParams()
  const navigate = useNavigate()
  const { data: pet, isLoading, error } = usePet(petId)
  const updatePet = useUpdatePet(petId)
  const deletePet = useDeletePet()
  const [isEditing, setIsEditing] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const notFound = error instanceof HTTPError && error.response.status === 404

  if (isLoading) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <p className="text-sm text-muted-foreground">Loading pet…</p>
      </main>
    )
  }

  if (notFound || !pet) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
        <p className="text-sm text-destructive" data-testid="pet-not-found">
          Pet not found.
        </p>
        <Link to="/pets" className="text-sm underline underline-offset-4">
          Back to My Pets
        </Link>
      </main>
    )
  }

  async function handleDelete() {
    if (!window.confirm(`Delete ${pet!.name}? This cannot be undone.`)) return
    setDeleteError(null)
    try {
      await deletePet.mutateAsync(pet!.id)
      navigate({ to: "/pets" })
    } catch {
      setDeleteError("Could not delete this pet.")
    }
  }

  if (isEditing) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="mb-6 text-xl font-semibold">Edit {pet.name}</h1>
        <PetForm
          submitLabel="Save changes"
          pending={updatePet.isPending}
          initialValues={{
            name: pet.name,
            species: pet.species,
            breed: pet.breed ?? "",
            sex: pet.sex,
            dateOfBirth: pet.dateOfBirth ?? "",
            weight: pet.weight != null ? String(pet.weight) : "",
            photoUrl: pet.photoUrl ?? "",
          }}
          onSubmit={async (input) => {
            await updatePet.mutateAsync(input)
            setIsEditing(false)
          }}
          onCancel={() => setIsEditing(false)}
        />
      </main>
    )
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div>
        <Link to="/pets" className="text-sm underline underline-offset-4">
          Back to My Pets
        </Link>
      </div>
      <h1 className="text-xl font-semibold" data-testid="pet-detail-name">
        {pet.name}
      </h1>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Species</dt>
        <dd>{pet.species}</dd>
        <dt className="text-muted-foreground">Breed</dt>
        <dd>{pet.breed ?? "—"}</dd>
        <dt className="text-muted-foreground">Sex</dt>
        <dd>{pet.sex}</dd>
        <dt className="text-muted-foreground">Date of birth</dt>
        <dd>{pet.dateOfBirth ?? "—"}</dd>
        <dt className="text-muted-foreground">Weight</dt>
        <dd>{pet.weight != null ? `${pet.weight} kg` : "—"}</dd>
      </dl>
      {deleteError && (
        <p role="alert" className="text-sm text-destructive">
          {deleteError}
        </p>
      )}
      <div className="flex gap-3">
        <Button onPress={() => setIsEditing(true)}>Edit</Button>
        <Button variant="destructive" onPress={handleDelete} isDisabled={deletePet.isPending}>
          {deletePet.isPending ? "Deleting…" : "Delete"}
        </Button>
      </div>
    </main>
  )
}

import { useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { PetForm } from "@/features/pets/components/PetForm"
import { useCreatePet, usePets } from "@/features/pets/hooks"

export const Route = createFileRoute("/_authenticated/pets/")({
  component: PetsPage,
})

function PetsPage() {
  const { data: pets, isLoading, isError } = usePets()
  const createPet = useCreatePet()
  const [showForm, setShowForm] = useState(false)

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">My Pets</h1>
        <Button onPress={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "Add Pet"}</Button>
      </div>

      {showForm && (
        <div className="rounded border border-border p-4">
          <PetForm
            submitLabel="Add Pet"
            pending={createPet.isPending}
            onSubmit={async (input) => {
              await createPet.mutateAsync(input)
              setShowForm(false)
            }}
            onCancel={() => setShowForm(false)}
          />
        </div>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading pets…</p>}
      {isError && <p className="text-sm text-destructive">Could not load your pets.</p>}

      {pets && pets.length === 0 && !showForm && (
        <p className="text-sm text-muted-foreground" data-testid="pets-empty-state">
          You haven't added any pets yet.
        </p>
      )}

      {pets && pets.length > 0 && (
        <ul className="flex flex-col gap-3" data-testid="pets-list">
          {pets.map((pet) => (
            <li key={pet.id} className="rounded border border-border p-4">
              <Link to="/pets/$petId" params={{ petId: pet.id }} className="flex flex-col gap-1">
                <span className="font-medium" data-testid="pet-name">
                  {pet.name}
                </span>
                <span className="text-sm text-muted-foreground">
                  {pet.species}
                  {pet.breed ? ` · ${pet.breed}` : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

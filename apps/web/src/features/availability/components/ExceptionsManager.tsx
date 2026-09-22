import { useState } from "react"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/api/errors"
import { useCreateException, useDeleteException, useExceptions } from "../hooks"
import { exceptionInputSchema } from "../schemas"

type FormValues = { date: string; type: "CLOSED" | "CUSTOM_HOURS"; startTime: string; endTime: string; reason: string }
const EMPTY_FORM: FormValues = { date: "", type: "CLOSED", startTime: "", endTime: "", reason: "" }

export function ExceptionsManager({ providerId }: { providerId: string }) {
  const { data: exceptions, isLoading, isError } = useExceptions(providerId)
  const createExc = useCreateException(providerId)
  const deleteExc = useDeleteException(providerId)
  const [showForm, setShowForm] = useState(false)
  const [values, setValues] = useState<FormValues>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    const parsed = exceptionInputSchema.safeParse({
      date: values.date,
      type: values.type,
      startTime: values.type === "CUSTOM_HOURS" ? values.startTime : undefined,
      endTime: values.type === "CUSTOM_HOURS" ? values.endTime : undefined,
      reason: values.reason,
    })
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Invalid input")
      return
    }
    try {
      await createExc.mutateAsync(parsed.data)
      setValues(EMPTY_FORM)
      setShowForm(false)
    } catch (err) {
      setFormError(await toErrorMessage(err, "Could not create this exception"))
    }
  }

  async function handleDelete(exceptionId: string) {
    setDeleteError(null)
    try {
      await deleteExc.mutateAsync(exceptionId)
    } catch (err) {
      setDeleteError(await toErrorMessage(err, "Could not delete this exception"))
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="exceptions-manager">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Date exceptions</h3>
        <Button size="sm" onPress={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "Add exception"}
        </Button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Date
            <input
              type="date"
              value={values.date}
              onChange={(e) => update("date", e.target.value)}
              className="rounded border border-border bg-background px-3 py-2 text-sm"
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Type
            <select
              value={values.type}
              onChange={(e) => update("type", e.target.value as FormValues["type"])}
              className="rounded border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="CLOSED">Closed</option>
              <option value="CUSTOM_HOURS">Custom hours</option>
            </select>
          </label>
          {values.type === "CUSTOM_HOURS" && (
            <>
              <label className="flex flex-col gap-1 text-sm">
                Start
                <input
                  type="time"
                  value={values.startTime}
                  onChange={(e) => update("startTime", e.target.value)}
                  className="rounded border border-border bg-background px-3 py-2 text-sm"
                  required
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                End
                <input
                  type="time"
                  value={values.endTime}
                  onChange={(e) => update("endTime", e.target.value)}
                  className="rounded border border-border bg-background px-3 py-2 text-sm"
                  required
                />
              </label>
            </>
          )}
          <label className="flex flex-col gap-1 text-sm">
            Reason (optional)
            <input
              type="text"
              value={values.reason}
              onChange={(e) => update("reason", e.target.value)}
              className="rounded border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
          <Button type="submit" isDisabled={createExc.isPending}>
            {createExc.isPending ? "Saving…" : "Save"}
          </Button>
          {formError && (
            <p role="alert" className="w-full text-sm text-destructive" data-testid="exception-form-error">
              {formError}
            </p>
          )}
        </form>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading exceptions…</p>}
      {isError && <p className="text-sm text-destructive">Could not load exceptions.</p>}
      {exceptions && exceptions.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="exceptions-empty-state">
          No date exceptions yet.
        </p>
      )}
      {exceptions && exceptions.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="exceptions-list">
          {exceptions.map((exc) => (
            <li key={exc.id} className="flex items-center justify-between rounded border border-border p-3" data-testid="exception-row">
              <span>
                <strong>{exc.date}</strong>{" "}
                {exc.type === "CLOSED" ? "Closed" : `Custom hours ${exc.startTime?.slice(0, 5)}–${exc.endTime?.slice(0, 5)}`}
                {exc.reason ? ` (${exc.reason})` : ""}
              </span>
              <Button size="sm" variant="destructive" onPress={() => handleDelete(exc.id)} isDisabled={deleteExc.isPending}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
    </div>
  )
}

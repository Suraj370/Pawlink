import { useState } from "react"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/api/errors"
import { useCreateWeeklyRule, useDeleteWeeklyRule, useUpdateWeeklyRule, useWeeklyRules } from "../hooks"
import { DAY_OF_WEEK_VALUES, weeklyRuleInputSchema } from "../schemas"
import type { PublicWeeklyRule, WeeklyRuleInput } from "../schemas"

type FormValues = { dayOfWeek: string; startTime: string; endTime: string }
const EMPTY_FORM: FormValues = { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" }

function RuleForm({
  initial,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: FormValues
  pending: boolean
  error: string | null
  onSubmit: (input: WeeklyRuleInput) => void
  onCancel: () => void
}) {
  const [values, setValues] = useState<FormValues>(initial ?? EMPTY_FORM)
  const [fieldError, setFieldError] = useState<string | null>(null)

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFieldError(null)
    const parsed = weeklyRuleInputSchema.safeParse(values)
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Invalid input")
      return
    }
    onSubmit(parsed.data)
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Day
        <select
          value={values.dayOfWeek}
          onChange={(e) => setValues((v) => ({ ...v, dayOfWeek: e.target.value }))}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
        >
          {DAY_OF_WEEK_VALUES.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Start
        <input
          type="time"
          value={values.startTime}
          onChange={(e) => setValues((v) => ({ ...v, startTime: e.target.value }))}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        End
        <input
          type="time"
          value={values.endTime}
          onChange={(e) => setValues((v) => ({ ...v, endTime: e.target.value }))}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          required
        />
      </label>
      <Button type="submit" isDisabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
      <Button type="button" variant="ghost" onPress={onCancel}>
        Cancel
      </Button>
      {(fieldError ?? error) && (
        <p role="alert" className="w-full text-sm text-destructive" data-testid="rule-form-error">
          {fieldError ?? error}
        </p>
      )}
    </form>
  )
}

function RuleRow({ providerId, rule }: { providerId: string; rule: PublicWeeklyRule }) {
  const [isEditing, setIsEditing] = useState(false)
  const updateRule = useUpdateWeeklyRule(providerId, rule.id)
  const deleteRule = useDeleteWeeklyRule(providerId)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  async function handleDelete() {
    setDeleteError(null)
    try {
      await deleteRule.mutateAsync(rule.id)
    } catch (err) {
      setDeleteError(await toErrorMessage(err, "Could not delete this window"))
    }
  }

  if (isEditing) {
    return (
      <li className="rounded border border-border p-3">
        <RuleForm
          initial={{ dayOfWeek: rule.dayOfWeek, startTime: rule.startTime.slice(0, 5), endTime: rule.endTime.slice(0, 5) }}
          pending={updateRule.isPending}
          error={null}
          onSubmit={async (input) => {
            await updateRule.mutateAsync(input)
            setIsEditing(false)
          }}
          onCancel={() => setIsEditing(false)}
        />
      </li>
    )
  }

  return (
    <li className="flex items-center justify-between rounded border border-border p-3" data-testid="rule-row">
      <span>
        <strong>{rule.dayOfWeek}</strong> {rule.startTime.slice(0, 5)}–{rule.endTime.slice(0, 5)}
      </span>
      <span className="flex gap-2">
        <Button size="sm" onPress={() => setIsEditing(true)}>
          Edit
        </Button>
        <Button size="sm" variant="destructive" onPress={handleDelete} isDisabled={deleteRule.isPending}>
          Delete
        </Button>
      </span>
      {deleteError && <span className="text-sm text-destructive">{deleteError}</span>}
    </li>
  )
}

export function WeeklyRulesManager({ providerId }: { providerId: string }) {
  const { data: rules, isLoading, isError } = useWeeklyRules(providerId)
  const createRule = useCreateWeeklyRule(providerId)
  const [showForm, setShowForm] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-3" data-testid="weekly-rules-manager">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Weekly hours</h3>
        <Button size="sm" onPress={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "Add window"}
        </Button>
      </div>

      {showForm && (
        <RuleForm
          pending={createRule.isPending}
          error={createError}
          onSubmit={async (input) => {
            setCreateError(null)
            try {
              await createRule.mutateAsync(input)
              setShowForm(false)
            } catch (err) {
              setCreateError(await toErrorMessage(err, "Could not add this window"))
            }
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading weekly hours…</p>}
      {isError && <p className="text-sm text-destructive">Could not load weekly hours.</p>}
      {rules && rules.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="rules-empty-state">
          No weekly hours set yet.
        </p>
      )}
      {rules && rules.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="rules-list">
          {rules.map((rule) => (
            <RuleRow key={rule.id} providerId={providerId} rule={rule} />
          ))}
        </ul>
      )}
    </div>
  )
}

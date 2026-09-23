import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Pagination } from "@/features/admin/components/Pagination"
import { useAdminAudit } from "@/features/admin/hooks"

export const Route = createFileRoute("/_authenticated/admin/audit")({
  component: AdminAuditPage,
})

const ACTION_VALUES = [
  "MEDICAL_RECORD_CREATED",
  "MEDICAL_RECORD_VIEWED",
  "MEDICAL_RECORD_UPDATED",
  "MEDICAL_RECORD_ARCHIVED",
  "AUTHORIZATION_DENIED",
  "PROVIDER_STATUS_CHANGED",
  "ADMIN_REVIEW_HIDDEN",
  "ADMIN_REVIEW_PUBLISHED",
] as const
const PAGE_SIZE = 100

function AdminAuditPage() {
  const [action, setAction] = useState<(typeof ACTION_VALUES)[number] | "">("")
  const [page, setPage] = useState(1)
  const { data, isLoading, isError } = useAdminAudit({ action: action || undefined, page, pageSize: PAGE_SIZE })

  return (
    <section className="flex flex-col gap-4" data-testid="admin-audit-page">
      <select
        value={action}
        onChange={(e) => {
          setAction(e.target.value as typeof action)
          setPage(1)
        }}
        className="rounded border border-border bg-background px-3 py-2 text-sm"
      >
        <option value="">All actions</option>
        {ACTION_VALUES.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>

      {isLoading && <p className="text-sm text-muted-foreground">Loading audit log…</p>}
      {isError && <p className="text-sm text-destructive">Could not load the audit log.</p>}

      {data && (
        <>
          <ul className="flex flex-col gap-2" data-testid="admin-audit-list">
            {data.entries.map((entry) => (
              <li key={entry.id} className="rounded border border-border p-3 text-sm" data-testid="admin-audit-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{entry.action}</span>
                  <span className="text-muted-foreground">{entry.createdAt.slice(0, 19).replace("T", " ")}</span>
                </div>
                <p className="text-muted-foreground">
                  {entry.actorName} · {entry.resourceType}
                  {entry.resourceId ? ` #${entry.resourceId.slice(0, 8)}…` : ""}
                </p>
              </li>
            ))}
          </ul>
          {data.entries.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="admin-audit-empty-state">
              No audit entries match this filter.
            </p>
          )}
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
        </>
      )}
    </section>
  )
}

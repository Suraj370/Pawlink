import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Pagination } from "@/features/admin/components/Pagination"
import { useAdminUsers } from "@/features/admin/hooks"

export const Route = createFileRoute("/_authenticated/admin/users")({
  component: AdminUsersPage,
})

const PAGE_SIZE = 20

function AdminUsersPage() {
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const { data, isLoading, isError } = useAdminUsers({ search: search || undefined, page, pageSize: PAGE_SIZE })

  return (
    <section className="flex flex-col gap-4" data-testid="admin-users-page">
      <input
        type="text"
        placeholder="Search by name…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value)
          setPage(1)
        }}
        className="rounded border border-border bg-background px-3 py-2 text-sm"
        data-testid="admin-user-search"
      />

      {isLoading && <p className="text-sm text-muted-foreground">Loading users…</p>}
      {isError && <p className="text-sm text-destructive">Could not load users.</p>}

      {data && (
        <>
          <table className="w-full text-left text-sm" data-testid="admin-users-table">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-2">Name</th>
                <th className="py-2">Role</th>
                <th className="py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((user) => (
                <tr key={user.id} className="border-b border-border" data-testid="admin-user-row">
                  <td className="py-2">{user.name}</td>
                  <td className="py-2">{user.role}</td>
                  <td className="py-2">{user.createdAt.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.users.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="admin-users-empty-state">
              No users match this search.
            </p>
          )}
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
        </>
      )}
    </section>
  )
}

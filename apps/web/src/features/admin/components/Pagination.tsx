import { Button } from "@/components/ui/button"

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (totalPages <= 1) return null

  return (
    <div className="flex items-center justify-between gap-3 text-sm" data-testid="admin-pagination">
      <span className="text-muted-foreground">
        Page {page} of {totalPages} ({total} total)
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" isDisabled={page <= 1} onPress={() => onPageChange(page - 1)}>
          Previous
        </Button>
        <Button size="sm" variant="outline" isDisabled={page >= totalPages} onPress={() => onPageChange(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  )
}

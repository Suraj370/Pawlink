import { Hono } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import { adminAuditListQuerySchema } from "@pawlink/shared";
import type { AppEnv } from "../../types.js";
import type { DbClient } from "../../db/client.js";
import { auditLogs, users } from "../../db/schema.js";
import { createRequireAdmin } from "../../middleware/auth.js";

// -----------------------------------------------------------------------
// GET /api/admin/audit — read-only, by design. There is no PATCH/DELETE
// anywhere in this router (or anywhere in this codebase at all — see
// lib/audit.ts) for an audit_logs row; even an admin cannot rewrite or
// erase history through any HTTP route (see the milestone brief, "Audit
// logs are historical evidence").
//
// This intentionally surfaces EVERY action value, including the
// medical-records ones (MEDICAL_RECORD_CREATED/VIEWED/UPDATED/ARCHIVED).
// That is NOT medical-record access: an audit row's `metadata` never
// carries clinical content (see routes/medical-records.ts — enforced
// there, not re-validated here, since this endpoint only ever reads rows
// that were already written under that constraint), only structural
// context (which field changed, a record count). What this endpoint
// reveals is that an access happened, by whom, and when — the entire
// point of an audit trail — never what was actually recorded or viewed.
// See docs/architecture.md, "Admin & operations — medical-record
// restriction," for the exact boundary this endpoint respects.
// -----------------------------------------------------------------------
export function createAdminAuditRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  app.use("*", createRequireAdmin(db, nodeEnv));

  app.get("/", async (c) => {
    const parsedQuery = adminAuditListQuerySchema.safeParse({
      action: c.req.query("action") || undefined,
      resourceType: c.req.query("resourceType") || undefined,
      page: c.req.query("page") ?? undefined,
      pageSize: c.req.query("pageSize") ?? undefined,
    });
    if (!parsedQuery.success) {
      return c.json({ error: "Invalid query", fields: parsedQuery.error.flatten().fieldErrors }, 400);
    }
    const { action, resourceType, page, pageSize } = parsedQuery.data;

    const conditions = [];
    if (action) conditions.push(eq(auditLogs.action, action));
    if (resourceType) conditions.push(eq(auditLogs.resourceType, resourceType));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalResult] = await Promise.all([
      db.query.auditLogs.findMany({
        where,
        orderBy: (a, { desc }) => [desc(a.createdAt)],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      db.select({ count: sql<number>`count(*)::int` }).from(auditLogs).where(where),
    ]);

    const actorIds = [...new Set(rows.map((r) => r.actorUserId))];
    const actors = actorIds.length > 0 ? await db.query.users.findMany({ where: inArray(users.id, actorIds) }) : [];
    const nameById = new Map(actors.map((u) => [u.id, u.name]));

    return c.json(
      {
        entries: rows.map((r) => ({
          id: r.id,
          actorUserId: r.actorUserId,
          actorName: nameById.get(r.actorUserId) ?? "Unknown",
          action: r.action,
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          petId: r.petId,
          providerId: r.providerId,
          metadata: r.metadata as Record<string, unknown> | null,
          createdAt: r.createdAt.toISOString(),
        })),
        page,
        pageSize,
        total: totalResult[0]?.count ?? 0,
      },
      200,
    );
  });

  return app;
}

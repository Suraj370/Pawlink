import { Hono } from "hono";
import { and, eq, ilike, sql } from "drizzle-orm";
import { adminUserListQuerySchema } from "@pawlink/shared";
import type { AppEnv } from "../../types.js";
import type { DbClient } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { toAdminUser } from "../../lib/admin.js";
import { createRequireAdmin } from "../../middleware/auth.js";

// GET /api/admin/users — read-only. There is deliberately no role-change
// endpoint here (see docs/architecture.md, "Admin & operations — role
// provisioning"): the milestone brief explicitly allows shipping role
// changes as unavailable in a first version, provisioning admins through
// a controlled database mechanism instead — which is already this
// codebase's existing, established pattern (see test-helpers.ts's
// promoteToAdmin; there has never been an API path to become an admin).
export function createAdminUserRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  app.use("*", createRequireAdmin(db, nodeEnv));

  app.get("/", async (c) => {
    const parsedQuery = adminUserListQuerySchema.safeParse({
      search: c.req.query("search") || undefined,
      role: c.req.query("role") || undefined,
      page: c.req.query("page") ?? undefined,
      pageSize: c.req.query("pageSize") ?? undefined,
    });
    if (!parsedQuery.success) {
      return c.json({ error: "Invalid query", fields: parsedQuery.error.flatten().fieldErrors }, 400);
    }
    const { search, role, page, pageSize } = parsedQuery.data;

    const conditions = [];
    // Search by display name only — never email, matching this
    // endpoint's data-minimization stance (see toAdminUser).
    if (search) conditions.push(ilike(users.name, `%${search}%`));
    if (role) conditions.push(eq(users.role, role));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalResult] = await Promise.all([
      db.query.users.findMany({
        where,
        orderBy: (u, { desc }) => [desc(u.createdAt)],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      db.select({ count: sql<number>`count(*)::int` }).from(users).where(where),
    ]);

    return c.json(
      { users: rows.map(toAdminUser), page, pageSize, total: totalResult[0]?.count ?? 0 },
      200,
    );
  });

  return app;
}

import type { PublicUser } from "@pawlink/shared";
import type { users } from "../db/schema.js";

type UserRow = typeof users.$inferSelect;

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

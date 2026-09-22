import type { PublicService } from "@pawlink/shared";
import type { services } from "../db/schema.js";

type ServiceRow = typeof services.$inferSelect;

export function toPublicService(service: ServiceRow): PublicService {
  return {
    id: service.id,
    providerId: service.providerId,
    name: service.name,
    description: service.description,
    durationMinutes: service.durationMinutes,
    priceMinor: service.priceMinor,
    currency: service.currency,
    active: service.active,
    createdAt: service.createdAt.toISOString(),
    updatedAt: service.updatedAt.toISOString(),
  };
}

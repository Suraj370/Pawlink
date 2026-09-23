import type { ProviderStatus, PublicProvider, ReviewAggregate, Role } from "@pawlink/shared";
import type { providers } from "../db/schema.js";

type ProviderRow = typeof providers.$inferSelect;

// aggregate is always supplied by the caller (routes/providers.ts),
// computed fresh from the reviews table for the rows actually being
// returned — never a cached column on the provider row itself, and never
// optional/defaulted here, so a route can't forget to compute it and
// silently ship a wrong rating.
export function toPublicProvider(provider: ProviderRow, isOwner: boolean, aggregate: ReviewAggregate): PublicProvider {
  return {
    id: provider.id,
    businessName: provider.businessName,
    providerType: provider.providerType,
    description: provider.description,
    phone: provider.phone,
    email: provider.email,
    address: provider.address,
    city: provider.city,
    state: provider.state,
    postalCode: provider.postalCode,
    latitude: provider.latitude,
    longitude: provider.longitude,
    timezone: provider.timezone,
    status: provider.status,
    isOwner,
    averageRating: aggregate.averageRating,
    reviewCount: aggregate.reviewCount,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

export class StatusTransitionError extends Error {}

// Only an admin may suspend a provider or change the status of one that's
// already suspended — otherwise an owner could simply "un-suspend"
// themselves by setting status back to ACTIVE, defeating the point of
// platform-level suspension. Outside of SUSPENDED, an owner may freely
// toggle their own provider between ACTIVE and INACTIVE.
export function assertStatusTransitionAllowed(
  currentStatus: ProviderStatus,
  nextStatus: ProviderStatus,
  actorRole: Role,
): void {
  if (actorRole === "ADMIN") return;

  if (currentStatus === "SUSPENDED") {
    throw new StatusTransitionError("Only an administrator can change a suspended provider's status");
  }

  if (nextStatus === "SUSPENDED") {
    throw new StatusTransitionError("Only an administrator can suspend a provider");
  }
}

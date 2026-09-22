import type { ProviderStatus, PublicProvider, Role } from "@pawlink/shared";
import type { providers } from "../db/schema.js";

type ProviderRow = typeof providers.$inferSelect;

export function toPublicProvider(provider: ProviderRow, isOwner: boolean): PublicProvider {
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
    status: provider.status,
    isOwner,
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

import { Dog, Home, Scissors, Stethoscope } from "lucide-react"
import type { ProviderType } from "./schemas"

export const PROVIDER_TYPE_META: Record<ProviderType, { label: string; plural: string; icon: typeof Stethoscope }> = {
  VET: { label: "Veterinarian", plural: "Veterinarians", icon: Stethoscope },
  GROOMER: { label: "Groomer", plural: "Groomers", icon: Scissors },
  BOARDING_PROVIDER: { label: "Boarding", plural: "Boarding & sitting", icon: Home },
  PET_SHOP: { label: "Pet shop", plural: "Pet shops", icon: Dog },
}

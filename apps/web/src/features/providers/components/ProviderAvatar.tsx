import { Dog, Home, Scissors, Stethoscope } from "lucide-react"
import { cn } from "cn"
import type { ProviderType } from "@/features/providers/schemas"

// This app has no photo-upload feature (no field for it on the provider
// model), so every "avatar" is a deterministic, generated placeholder —
// a colored tile keyed off the provider's own id — rather than a fake
// stock photo pretending to be a real business. The icon communicates
// provider type at a glance; the color gives each card its own identity
// in a list.
const PALETTE = [
  "bg-primary/15 text-primary",
  "bg-accent text-accent-foreground",
  "bg-secondary text-secondary-foreground",
  "bg-[oklch(0.85_0.09_150)] text-[oklch(0.32_0.06_150)]",
  "bg-[oklch(0.85_0.07_250)] text-[oklch(0.32_0.06_250)]",
]

const TYPE_ICON: Record<ProviderType, typeof Stethoscope> = {
  VET: Stethoscope,
  GROOMER: Scissors,
  BOARDING_PROVIDER: Home,
  PET_SHOP: Dog,
}

function paletteIndex(id: string) {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return hash % PALETTE.length
}

type Props = {
  id: string
  providerType: ProviderType
  className?: string
}

export function ProviderAvatar({ id, providerType, className }: Props) {
  const Icon = TYPE_ICON[providerType]
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl",
        PALETTE[paletteIndex(id)],
        className
      )}
    >
      <Icon className="size-[45%]" strokeWidth={1.75} />
    </div>
  )
}

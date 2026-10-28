import * as React from "react"
import { Slot as SlotPrimitive } from "radix-ui"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@closedloop-ai/design-system/lib/utils"
import { INVALID_STATE_UTILITIES } from "./invalid-state"

const badgeVariants = cva(
  `inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-[3px] focus-visible:ring-offset-2 focus-visible:ring-offset-background ${INVALID_STATE_UTILITIES} transition-[color,box-shadow] overflow-hidden`,
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "border-transparent bg-destructive text-white [a&]:hover:bg-destructive/90 dark:bg-destructive/60",
        error:
          "border-destructive/25 bg-destructive/12 text-destructive [a&]:hover:bg-destructive/18",
        success:
          "border-success/25 bg-success/12 text-success [a&]:hover:bg-success/18",
        warning:
          "border-warning/30 bg-warning/14 text-warning-foreground [a&]:hover:bg-warning/20",
        info: "border-info/25 bg-info/12 text-info [a&]:hover:bg-info/18",
        accent:
          "border-primary/20 bg-primary/10 text-primary [a&]:hover:bg-primary/16",
        // FEA-4035: the agentic/AI tone, reading the theme's `--ai` /
        // `--ai-foreground` pair. Added so the loop-command tones — which are
        // `ai` on nine of fourteen commands — can route through this one
        // variant vocabulary instead of a hand-maintained className map beside
        // it. The fill/border/text triple is byte-for-byte the `COLOR_AI`
        // literal `status-badge.tsx` maintained separately before this variant
        // existed, so every existing AI-toned badge renders unchanged.
        ai: "border-ai/30 bg-ai/10 text-ai-foreground [a&]:hover:bg-ai/16",
        muted:
          "border-border bg-muted/70 text-muted-foreground [a&]:hover:bg-muted",
        // FEA-4035: the neutral OUTLINED pill — a bordered, filled-with-`input`
        // chip whose text stays the plain foreground. Distinct from `default`
        // (a solid primary chip) and from `outline` (no fill at all). It exists
        // because `ToneBadge` shipped exactly these three utilities as its own
        // `default` row, which is the drift this ticket collapses: that row is
        // now this variant rather than a fourth parallel tone map.
        neutral: "border-input-border bg-input text-foreground",
        outline:
          "text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>

// Exhaustive, so a new `variant` added to `badgeVariants` above fails `tsc`
// here until it is added below too — an array literal compiled regardless of
// whether it matched, which is how `ai`/`neutral` shipped in the Controls
// dropdown but missing from the AllVariants/LabelVsBadge comparison stories.
// Same pattern as `BADGE_VARIANT_COVERAGE` in
// packages/app/test/a11y/theme-contrast-pairs.node.ts.
const BADGE_VARIANT_COVERAGE: Record<BadgeVariant, true> = {
  default: true,
  secondary: true,
  destructive: true,
  error: true,
  success: true,
  warning: true,
  info: true,
  accent: true,
  ai: true,
  muted: true,
  neutral: true,
  outline: true,
}

// The single source of truth for "every badge variant" — Storybook's
// argTypes options and the AllVariants/LabelVsBadge comparison stories read
// this instead of each hand-typing their own copy of the list above.
export const BADGE_VARIANTS = Object.keys(
  BADGE_VARIANT_COVERAGE
) as readonly BadgeVariant[]

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? SlotPrimitive.Slot : "span"

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

type BadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean };

export { Badge, badgeVariants }
export type { BadgeProps }

import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { ReactNode } from "react";

/**
 * Semantic tone of a desktop branch status banner. Maps to the design-system
 * semantic color tokens (`success`/`warning`/`destructive`) — the same palette
 * the shared `Alert` variants use — instead of the raw `emerald`/`amber`/`red`
 * Tailwind scales the branch banners previously hand-rolled (FEA-2616).
 */
export type DesktopStatusBannerTone = "success" | "warning" | "error";

/**
 * Which branch surface renders the banner, selecting its chrome:
 * - `list` — a rounded inline card in the branches table header (px-3 py-2).
 * - `detail` — a full-width bottom-border banner in the branch detail view.
 */
export type DesktopStatusBannerVariant = "list" | "detail";

// Class names are spelled out in full (never interpolated) so Tailwind's JIT
// keeps them. Tone classes mirror the design-system `Alert` semantic variants —
// a tinted `/12` background, a `/30` border, and semantic foreground text — so
// the banners track the theme instead of pinning to raw color scales.
const TONE_CLASS_NAME: Record<DesktopStatusBannerTone, string> = {
  success: "text-success-foreground bg-success/12 border-success/30",
  warning: "text-warning-foreground bg-warning/12 border-warning/30",
  error: "text-destructive bg-destructive/12 border-destructive/30",
};

const VARIANT_CLASS_NAME: Record<DesktopStatusBannerVariant, string> = {
  list: "rounded-md border px-3 py-2 text-xs",
  detail: "border-b px-4 py-2 text-xs",
};

/**
 * Shared status banner for the desktop branch surfaces (list + detail).
 * Consolidates the six near-identical hand-rolled banners that each spelled out
 * raw `emerald`/`amber`/`red` Tailwind scales, mapping a semantic `tone` to the
 * design-system color tokens and a `variant` to the surface chrome (FEA-2616).
 */
export function DesktopStatusBanner({
  tone,
  variant,
  children,
}: {
  tone: DesktopStatusBannerTone;
  variant: DesktopStatusBannerVariant;
  children: ReactNode;
}) {
  return (
    <div className={cn(VARIANT_CLASS_NAME[variant], TONE_CLASS_NAME[tone])}>
      {children}
    </div>
  );
}

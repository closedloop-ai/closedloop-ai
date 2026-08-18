import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { ReactNode } from "react";
import type { BadgeProps } from "./badge";

/**
 * A plain colored text label — the low-emphasis sibling of `Badge`/`Chip`
 * (FEA-3968). Per the design discipline, a filled badge is reserved for
 * genuinely varying status that benefits from emphasis (Running vs Completed);
 * a low-variance categorical value (a Command that is "Manual" on every row, a
 * Type that is "Tool" on every row) reads as clutter when boxed, so it renders
 * as a plain colored string instead.
 *
 * The color comes from the SAME variant vocabulary `Badge`/`Chip` already use
 * (single source of truth): `<ToneLabel variant={sameVariantAsTheBadge}>`
 * renders the badge's text color with no fill or border. A caller keeps its
 * canonical status→variant map and picks the badge or the label at the render
 * site, never a second color source.
 */

export type ToneLabelVariant = NonNullable<BadgeProps["variant"]>;

/**
 * Variant → text-color class. Mirrors the `text-*` half of the `badgeVariants`
 * fills in `badge.tsx`, dropping the `bg`/`border`. `default`/`secondary` have
 * no distinct colored text as a label (their badge fill carries the color), so
 * they fall back to the neutral foreground — a plain label reads as text, not
 * as an inverted chip.
 *
 * `success`/`info` read from the `-foreground` tokens, NOT the `--info`/
 * `--success` fill tokens: those fills are tuned to sit under white chip text,
 * so as label text on `--card` they land under 4.5:1 at `text-xs` and fail
 * WCAG AA in both themes. The theme ships `--info-foreground` /
 * `--success-foreground` for exactly this on-surface text job (and `warning`
 * already reaches for `text-warning-foreground`), so all three stay consistent.
 */
const TONE_TEXT_CLASS: Record<ToneLabelVariant, string> = {
  default: "text-foreground",
  secondary: "text-foreground",
  destructive: "text-destructive",
  error: "text-destructive",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  info: "text-info-foreground",
  accent: "text-primary",
  // FEA-4035: like `success`/`info` above, the label reads the `-foreground`
  // token rather than the `--ai` fill. `--ai` is tuned to sit under a chip's
  // 10%-opacity wash, so as plain `text-xs` text on `--card` it lands under
  // 4.5:1; `--ai-foreground` is the on-surface pair the theme ships for exactly
  // this job, and is what the loop-command text tone already reached for before
  // this variant existed.
  ai: "text-ai-foreground",
  muted: "text-muted-foreground",
  // FEA-4035: `neutral` is a bordered chip whose text is already the plain
  // foreground, so as a label it is the same neutral string `default` renders —
  // the fill and border are the whole difference, and a label has neither.
  neutral: "text-foreground",
  outline: "text-foreground",
};

export function ToneLabel({
  variant,
  className,
  children,
  title,
}: {
  /**
   * Accepts the nullable `Badge`/`Chip` variant directly (a `null`/`undefined`
   * variant falls back to the neutral `default` tone) so a caller can forward a
   * status→variant map entry without narrowing or a cast.
   */
  variant?: BadgeProps["variant"];
  className?: string;
  children: ReactNode;
  /**
   * Optional native `title` — surfaces a fuller accessible name / hover
   * description when the visible text is a short stem (e.g. a provenance label
   * whose one-line explanation lives in the tooltip).
   */
  title?: string;
}) {
  return (
    <span
      className={cn(
        "truncate font-medium text-xs",
        toneTextClass(variant),
        className
      )}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * The tone's text-color class on its own, for the one case a `ToneLabel` cannot
 * cover: a SIBLING element that must carry the same tone as the label it sits
 * beside — an alert icon next to a `warning` string, say. The icon cannot live
 * inside `ToneLabel` without turning its `truncate` into a no-op (an icon and a
 * text node inside one span become flex items, and `text-overflow` stops
 * applying), so it stays a sibling and reads its color from here.
 *
 * Exported so that sibling reads the SAME variant→color map the label does,
 * instead of hardcoding a color and drifting the moment a variant is retuned.
 */
export function toneTextClass(variant?: BadgeProps["variant"]): string {
  return TONE_TEXT_CLASS[variant ?? "default"];
}

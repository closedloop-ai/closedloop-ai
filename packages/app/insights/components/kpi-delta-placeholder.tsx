import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { MinusIcon } from "lucide-react";

// Shown in a KPI delta slot when a prior-period comparison is not available for
// the selected range. This covers the four RANGE-shaped reasons the delta can be
// absent — the 90d/"all" ranges have no well-defined prior window; shorter ranges
// lack a full prior period until there is enough history; (FEA-3959) a near-zero
// prior base is suppressed rather than shown as a division artifact; and
// (ISS-5003) a magnitude at or past the ±999% ceiling declines to compare rather
// than asserting a ratio this product cannot state.
//
// It does NOT cover the fifth reason: a metric whose producer computes no
// comparison at all (ISS-4995). That one is not about the range, so callers pass
// `KPI_NOT_COMPUTED_REASON` via `reason` — see `lib/kpi-no-comparison-copy.ts`.
//
// ISS-5003 (review thread): the copy is now reason-agnostic in fact, not just in
// intent. The previous wording — "needs a prior period with enough activity" —
// named a cause, and that cause is false for two of the four: a user whose prior
// window holds 1 session and whose current window holds 4,257 has a FULL prior
// period and abundant activity; the comparison is declined on our side, for the
// magnitude. Telling that user they lack activity blames their data for our gap,
// which is precisely what the FEA-4241 `reason` override was added to prevent.
// This states the outcome (no comparison for this range) and leaves the cause to
// a surface that actually knows it.
export const NO_COMPARISON_LABEL =
  "No prior-period comparison is available for this range.";

// Short, visible label for the placeholder chip. FEA-3960: an explicit
// "No comparison" chip reads as an intentional state, not a half-finished /
// forgotten card, so every KPI card carries the same delta-slot affordance
// whether or not it has a numeric delta. Reason-agnostic (see above): "no trend
// yet" implied time, which isn't true for the near-zero-base case.
//
// ISS-4995 (review thread): "comparison" is the one noun this concept gets, in
// the chip, in every reason sentence behind it, and in the branch-detail card's
// sentence next door. The constant was named for "trend" while its value said
// "No comparison", which is the same drift one layer down.
export const NO_COMPARISON_CHIP_LABEL = "No comparison";

type KpiDeltaPlaceholderVariant = "pill" | "bare";

/**
 * "No comparison" affordance for the KPI delta slot. Rendered instead of hiding
 * the slot so the KPI card/tile layout stays stable between ranges, and explains
 * the absence via a tooltip + a screen-reader label (rather than a bare em dash
 * that reads as forgotten/missing data). Shared by the Insights `KpiMetricTile`
 * and the overview / first-launch stats-row `MetricCard` so both surfaces behave
 * identically. FEA-3960.
 *
 * The `variant` matches each surface's *real* delta shape so the absent state
 * never out-designs the present one (FEA-3961 VQA): `"pill"` mirrors the
 * `MetricCard` numeric delta pill (rounded, muted, leading glyph); `"bare"`
 * mirrors the tile `TrendBadge`, whose real delta is bare text + an arrow with
 * no pill.
 */
export function KpiDeltaPlaceholder({
  variant = "pill",
  reason = NO_COMPARISON_LABEL,
}: {
  variant?: KpiDeltaPlaceholderVariant;
  /**
   * Tooltip + screen-reader sentence explaining WHY there is no comparison. The
   * visible chip label stays "No comparison" everywhere; only the explanation
   * changes. Defaults to the Insights range-based reason (a full prior period
   * with enough activity). A surface where the comparison is absent for another
   * reason — e.g. the branch-detail cards, where a 30-day baseline simply isn't
   * computed for this surface yet — MUST pass an accurate reason so the tooltip
   * never blames the user's data for a gap on our side (FEA-4241).
   */
  reason?: string;
} = {}) {
  // ISS-4995 (review thread): the chip is the ONLY place the two no-comparison
  // states differ, so the reason has to be reachable without a mouse. It was a
  // bare `<span>` — not focusable, so a keyboard user could never open the
  // tooltip and the `sr-only` sentence was the sole remaining path in.
  //
  // It is a `<button type="button">` rather than a focusable span. The span is
  // what FEA-4026 reached for on the Properties panel (`agents/components/
  // detail/property-values.tsx`), on the reasoning that opening a tooltip is not
  // an activation — but that site only clears Biome's `noNoninteractiveTabindex`
  // because its `tabIndex` is a conditional expression the rule cannot resolve
  // statically. A literal `tabIndex={0}` on a span fails lint, so the span
  // pattern is not actually available here; the button is the lint-clean way to
  // put the reason in the tab order, and it is what the review asked for.
  //
  // No `aria-label`: the chip's own text plus the `sr-only` sentence ARE the
  // accessible name, and a label would replace them rather than add to them.
  //
  // `cursor-default` is load-bearing (ISS-4995 review thread). `globals.css`
  // gives every enabled `button` a pointer cursor in the base layer, so the
  // button that bought us the tab stop also started promising a click this chip
  // does not have, on ~12 of the 16 dashboard KPI cards, the Insights tiles, and
  // every branch-detail headline card. It has no `onClick`: the tooltip is the
  // whole payload, and Radix opens it on hover and on focus.
  //
  // Measured, not assumed: a pointer-down still dismisses the tooltip, and no
  // handler here can stop it. Radix's `TooltipContent` wraps a `DismissableLayer`
  // whose document-level listener treats a press on the trigger as an outside
  // interaction, so `preventDefault` at the button is too late. That is every
  // tooltip in the app, not this chip. The sibling `InfoHint` on the same tile
  // took the other road for the same problem (FEA-3819): a click PINS it, which
  // is also the only way a touch user, who has no hover, ever reads the text.
  // Adopting that model here is a behaviour change, not a cursor fix, so it is a
  // follow-up rather than part of this thread.
  //
  // The focus ring is imported, not retyped. `Chip`'s `interactive` variant
  // already ships exactly this treatment, and this pill stays a non-`Chip` on
  // purpose so it mirrors the hand-rolled `MetricDeltaChip` it sits beside
  // rather than out-designing the real delta it replaces (FEA-3961 VQA).
  const chipClassName =
    variant === "pill"
      ? `inline-flex cursor-default items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-medium text-[11px] text-muted-foreground ${CHIP_FOCUS_RING_CLASS}`
      : `inline-flex cursor-default items-center gap-0.5 rounded-sm font-medium text-muted-foreground text-xs ${CHIP_FOCUS_RING_CLASS}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={chipClassName}
          data-testid="kpi-delta-placeholder"
          type="button"
        >
          <MinusIcon aria-hidden="true" className="size-3" />
          {NO_COMPARISON_CHIP_LABEL}
          <span className="sr-only">{`. ${reason}`}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[220px]">{reason}</TooltipContent>
    </Tooltip>
  );
}

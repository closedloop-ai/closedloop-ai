import { LossClass } from "@/lib/analytics/session-fixture";

/**
 * One color assignment for the whole screen, so the strip, the trend chart, and
 * the cause lists read as a single system rather than three charts that happen
 * to sit together.
 *
 * The three loss classes take the design system's CATEGORICAL chart palette in
 * series order (`--chart-1..3`), which is what `TimeSeriesAreaChart` assigns to
 * the same three series, so a band in the chart and a segment in the bar are
 * the same color for the same class. A categorical palette encodes category,
 * not good/bad, and the meaning is always carried by a visible label beside the
 * swatch, never by hue alone (WCAG 2.2 SC 1.4.1). Both themes ship tuned values
 * for these tokens, so the assignment holds in light and dark.
 *
 * Productive time is deliberately achromatic: it is the denominator the loss is
 * read against, so it should recede and let the three loss classes separate.
 */
export const LOSS_CLASS_BAR_CLASS: Record<LossClass | "productive", string> = {
  productive: "bg-muted-foreground/25",
  [LossClass.Actionable]: "bg-chart-1",
  [LossClass.Systemic]: "bg-chart-2",
  [LossClass.Unattributed]: "bg-chart-3",
};

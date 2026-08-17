"use client";

import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import { formatMetricValue } from "@closedloop-ai/design-system/components/ui/primitives/format-metric-value";
import { InfoHint } from "@closedloop-ai/design-system/components/ui/primitives/info-hint";
import {
  deltaPillClass,
  deltaPillGeometryClass,
  deltaSentiment,
  deltaVerdictCaption,
  isComparableDelta,
  MetricDeltaTreatment,
  MetricPolarity,
} from "@closedloop-ai/design-system/components/ui/primitives/metric-polarity";
import { Sparkline } from "@closedloop-ai/design-system/components/ui/primitives/sparkline";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { formatDeltaPct, MAX_DELTA_PCT } from "@closedloop-ai/loops-api/insights";
import { MinusIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

/**
 * ISS-5070 item 5, landed by ISS-5366 (stage review): the label→trigger JOIN.
 *
 * ## The defect
 *
 * Wherever a host re-flows this label region to block/inline flow — today only
 * `SummaryCardRow`, via `SUMMARY_CARD_LABEL_REFLOW_CLASS` — the info trigger is a
 * trailing inline box, and every trailing inline box has a band of container
 * widths where the label TEXT fits on one line but the box's ~19px advance does
 * not fit after it. The line breaker then drops the glyph ALONE onto line two,
 * flush under the label's first letter, where it reads as a stray mark rather
 * than as that label's affordance.
 *
 * That band is card widths 205.8–224.8px, and BOTH shipped surfaces open inside
 * it, which is why this is landing rather than being deferred again:
 *
 *  - DESKTOP, the 1400px default window (`apps/desktop/src/shared/window-defaults.ts`)
 *    measures a 1099px strip track, so five compact cards are `(1099 - 4 * 16) / 5
 *    = 207px`.
 *  - WEB at a 1440px viewport: 1440 less the 16rem sidebar, the host's `px-4`
 *    gutters and the renderer's scrollbar is a ~1139px track, so
 *    `(1139 - 64) / 5 = 215px`.
 *
 * ## The fix, and why it is two `display: contents` spans
 *
 * This is a NOWRAP ISLAND, not a "wrap the last word" split. The outer span
 * carries `white-space: nowrap` and contains BOTH the label and the trigger, so
 * the soft-wrap opportunity at their boundary — whose nearest common ancestor is
 * that span — is suppressed. The inner span restores `white-space: normal` over
 * the label text alone, so the label itself still wraps between its own words.
 * The glyph therefore travels with the last word instead of orphaning.
 *
 * It is written this way rather than by slicing `label` into head + last word on
 * purpose: the label stays ONE text node, so `getByText("cost")`
 * and every `textContent` assertion across `packages/app`, `apps/desktop` and the
 * Playwright specs keep matching. A head/tail slice would have split that string
 * across two elements and broken all of them for a purely visual change.
 *
 * ## Why `contents`, i.e. why this is INERT for every other consumer
 *
 * `display: contents` generates no box, so for the Insights KPI tiles, the
 * Dashboard and Branches — every host that leaves this region as the
 * `flex items-center gap-1.5` row above — both spans dissolve and the flex
 * children are exactly what they were before this change: one anonymous text item
 * and the trigger, 6px apart. Those hosts also lay the region out on a single
 * non-wrapping flex line, where the trigger CANNOT orphan, so they need nothing
 * from the join and get no pixel of movement from it. That is what keeps this
 * item 5 and not ISS-5070 item 6, which moves the glyph for every consumer and
 * still needs its own visual pass against those tiles.
 *
 * A host that re-flows the region to block flow opts the island IN by flipping
 * both slots to `inline` — see `SUMMARY_CARD_LABEL_REFLOW_CLASS` in
 * `packages/app/shared/components/summary-card-row.tsx`, which is the one caller
 * that does. Tailwind extracts candidates from source text, so that host writes
 * the selectors as literals; these constants are the reviewable link between the
 * two files, and `metric-card-label-join.test.tsx` asserts they stay in step.
 */
export const METRIC_CARD_LABEL_JOIN_SLOT = "metric-card-label-join";

/** The inner half of the island: the label text, wrapping normally. */
export const METRIC_CARD_LABEL_TEXT_SLOT = "metric-card-label-text";

/**
 * The `delta`/`deltaPolarity` pair, as a discriminated union so a numeric
 * `delta` cannot be rendered without the metric declaring which direction is
 * good (ISS-4633, wongk review on #4148). There is deliberately NO
 * `deltaPolarity` default: a default would let any future spend/latency card omit
 * the semantic decision and silently compile back to the green-rise reading this
 * PR removes. A caller that has a period-over-period number MUST state its
 * polarity; a caller with no comparison passes neither (and may still fill the
 * slot with the base `deltaPlaceholder`).
 *
 * Only the `delta`/`deltaPolarity` pair is unioned; the other delta-slot fields
 * (`deltaLabel`, `deltaCapped`, `deltaPlaceholder`, `sparkline`) stay on the base
 * so the change is exactly wongk's ask — pair the semantic decision — without
 * churning every call site's placeholder wiring.
 */
type MetricCardDeltaProps =
  | {
      /**
       * Period-over-period change. A number renders a signed up/down chip whose
       * colour + verdict word come from `deltaPolarity` (paired: you cannot pass
       * one without the other).
       */
      delta: number;
      /**
       * Which direction is GOOD for this metric (ISS-4633). The chip's glyph
       * always reports the number's real direction; this decides whether that
       * movement reads as an improvement, a regression, or neither. Required
       * whenever `delta` is a number so a lower-is-better metric (spend,
       * time-to-merge, backlog) can never fall back to a rising figure looking
       * like a win.
       */
      deltaPolarity: MetricPolarity;
    }
  | {
      delta?: undefined;
      /** No numeric delta ⇒ no polarity to declare. */
      deltaPolarity?: never;
    };

type MetricCardBaseProps = {
  label: string;
  /**
   * The metric value. Pass `null`/`undefined` for a genuine no-data state — the
   * card then renders the muted "No data" glyph (see `valueUnavailable`) instead
   * of a value, so there is never a dead value to keep in sync beside the flag
   * (FEA-4236). A caller may also set `valueUnavailable` explicitly to force the
   * no-data slot for a non-null placeholder value.
   */
  value: string | number | null | undefined;
  /** Optional unit suffix rendered beside the formatted metric value. */
  unitLabel?: ReactNode;
  detail?: ReactNode;
  trend?: ReactNode;
  className?: string;
  /** Short explainer rendered in an info popover beside the label. */
  info?: { what: string; how?: string };
  /**
   * "No comparison" affordance rendered in the delta slot (the SAME position the
   * numeric chip occupies) when `delta` is omitted, so a card without a prior
   * period keeps the delta info in a stable slot rather than dropping it to a
   * different corner. Ignored when `delta` is a number.
   */
  deltaPlaceholder?: ReactNode;
  /**
   * Marks a numeric `delta` as clamped to a display ceiling by the caller, so
   * the chip renders the capped ">999%" / "<-999%" affordance instead of
   * implying the exact figure is meaningful. Ignored when `delta` is not a
   * number.
   */
  deltaCapped?: boolean;
  /** Caption beside the delta chip (e.g. "vs. prior 90 days"). */
  deltaLabel?: ReactNode;
  /**
   * Which delta presentation this consumer has opted into (ISS-5842). Defaults
   * to {@link MetricDeltaTreatment.Legacy} — the pre-ISS-5842 render — because
   * this primitive is shared by Sessions, Branches, the Insights dashboard and
   * the desktop first-launch dashboard on BOTH surfaces, and the ISS-4779
   * closed-by-default policy requires each of those to opt in through its own
   * platform gate rather than inherit a new look from a primitive bump. In
   * `packages/app`, resolve this with `useMetricDeltaTreatment()`.
   */
  deltaTreatment?: MetricDeltaTreatment;
  /**
   * Recent values for the metric. When provided (and the delta is a number),
   * the delta chip renders a real sparkline of the trend instead of a static
   * up/down icon. Falls back to the icon when fewer than two points exist.
   */
  sparkline?: Array<number | null | undefined>;
  /**
   * Renders the card at reduced opacity with a "Sample" badge to flag that its
   * value is placeholder data pending real backend wiring.
   */
  placeholder?: boolean;
  /**
   * Renders the card at reduced opacity WITHOUT the "Sample" badge, for a value
   * that is genuinely unavailable (a failed read) rather than demo data pending
   * wiring. Use with a caption such as `detail="Unavailable"` so the dimmed card
   * reads as "couldn't load this", never as a misleading "Sample". Ignored when
   * `placeholder` is set (the badge path wins).
   */
  muted?: boolean;
  /**
   * Renders the card frame — label, info popover, and footer/detail — intact but
   * skeletons ONLY the value slot, for a metric whose value is still hydrating.
   * Keeps the card's own height and chrome (never a bare grey slab that drops the
   * label and info while its siblings keep theirs), matching the partial-load
   * pattern the Insights tiles use. Use with a `detail` reason (e.g. "Importing
   * your history") so the card says why it's blank instead of only shimmering.
   */
  loading?: boolean;
  /**
   * The metric has no value to show (a genuine no-data state, not a failed read
   * or hydrating value). Renders a muted, smaller "No data" glyph in the value
   * slot INSTEAD of the passed `value`, so an absent metric never renders as a
   * bold 2xl em-dash — which reads like a struck/rule value rather than "nothing
   * to show" (FEA-4236). Pair with a `detail` caption that says WHY the value is
   * absent. Unlike `muted` (which dims the whole card for a failed read), this
   * keeps the card frame at full opacity and only softens the value itself.
   */
  valueUnavailable?: boolean;
  /** Copy for the no-data value slot when `valueUnavailable` is set. */
  valueUnavailableLabel?: ReactNode;
};

// A numeric `delta` carries a required `deltaPolarity` (see `MetricCardDeltaProps`);
// the base props and the `Card` passthrough compose around that union.
type MetricCardProps = MetricCardBaseProps &
  MetricCardDeltaProps &
  ComponentProps<typeof Card>;

export function MetricCard({
  label,
  value,
  unitLabel,
  detail,
  trend,
  className,
  info,
  delta,
  deltaPlaceholder,
  deltaCapped = false,
  // No polarity default: the discriminated `MetricCardDeltaProps` union makes
  // `deltaPolarity` required whenever `delta` is a number, so a rising figure
  // can never silently fall back to the green-rise reading (wongk review, #4148).
  deltaPolarity,
  deltaLabel,
  deltaTreatment = MetricDeltaTreatment.Legacy,
  sparkline,
  placeholder = false,
  muted = false,
  loading = false,
  valueUnavailable = false,
  valueUnavailableLabel = "No data",
  ...props
}: MetricCardProps) {
  // A nullish value IS a no-data state — derive it so callers never keep a dead
  // `value` in sync beside the flag (FEA-4236). An explicit `valueUnavailable`
  // still forces the slot for a non-null placeholder value.
  const noData = valueUnavailable || value == null;
  // `deltaPolarity` is present iff `delta` is a number (the `MetricCardDeltaProps`
  // union), but destructuring severs that link for the type checker — so gate on
  // both here to narrow the pair for the chip/caption, which each require a
  // non-optional polarity.
  // A non-finite delta (NaN / ±Infinity from a caller without its own finite
  // guard — e.g. a percent-change over a zero base) is really "no comparison",
  // not a real movement: without this it would slip through as a false "down"
  // and render a bogus chip (shafty023 review on #4148). Reject it here so the
  // card falls to the no-comparison placeholder instead of grading a non-number.
  const showDelta =
    delta !== undefined &&
    deltaPolarity !== undefined &&
    isComparableDelta(delta);
  // When there's no comparable numeric delta, the "no comparison" placeholder
  // fills the SAME delta slot (not a different footer corner) so the layout stays
  // stable.
  const showDeltaPlaceholder = !showDelta && Boolean(deltaPlaceholder);
  const hasFooter =
    Boolean(detail) ||
    Boolean(trend) ||
    showDelta ||
    showDeltaPlaceholder;

  return (
    <Card
      className={cn(
        "border-border bg-card",
        (placeholder || muted) && "opacity-50",
        className
      )}
      {...props}
    >
      <CardHeader
        className={cn(
          "flex min-w-0 flex-row items-start justify-between gap-4 space-y-0",
          // The header's bottom padding only earns its keep when a footer sits
          // beneath it; a footerless card (label + value only) would otherwise
          // land visually bottom-heavy against the card's own vertical padding.
          hasFooter ? "pb-3" : "pb-0"
        )}
      >
        <div className="min-w-0 space-y-1">
          {/* The label region carries NO height floor of its own (ISS-4787
              review, wongk): a reservation here would charge every consumer,
              including the Insights KPI tiles that are pinned to a fixed 156px
              host and would push their trend footer into the grid gutter. The
              shared-baseline reservation belongs to the surface that actually
              needs it — `SummaryCardRow` scopes it to the Sessions/Branches
              summary strips. */}
          <CardDescription className="flex items-center gap-1.5 font-semibold text-[11px] uppercase tracking-[0.12em]">
            {info ? (
              <span
                className="contents whitespace-nowrap"
                data-slot={METRIC_CARD_LABEL_JOIN_SLOT}
              >
                <span
                  className="contents whitespace-normal"
                  data-slot={METRIC_CARD_LABEL_TEXT_SLOT}
                >
                  {label}
                </span>
                <InfoHint
                  align="start"
                  contentClassName="w-60 space-y-1 p-3 text-xs"
                  // `h-6 -my-1` gives a real 24px-tall hit target (the point of
                  // FEA-3819 — a `size-3.5` glyph in a 16px box is still easy to
                  // miss above/below the "i") that collapses back into the
                  // label's 16px `leading-4` line box, so the glyph still tracks
                  // line one at any label length (including the summary strips'
                  // wrapped two-line labels). `-mx-1.5` likewise cancels the
                  // trigger's widened `px-1.5` so the label→icon gap is unchanged
                  // while the hover target reaches past the glyph on every side.
                  //
                  // Both values are unchanged by the nowrap island above, and a
                  // host that flips the island to `inline` must keep them that
                  // way: `SummaryCardRow` re-adds the 6px this row's flex
                  // `gap-1.5` supplies by setting `ml-0` (which leaves `px-1.5`
                  // uncancelled on the left — NOT `ml-1.5`, which stacks 6 on 6),
                  // and pairs it with `align-top` so this 16px margin box sits
                  // inside the label's line box instead of growing it.
                  label={`About ${label}`}
                  triggerClassName="h-6 -my-1 -mx-1.5"
                >
                  <p className="font-medium text-xs">{info.what}</p>
                  {info.how ? (
                    <p className="text-muted-foreground text-xs">{info.how}</p>
                  ) : null}
                </InfoHint>
              </span>
            ) : (
              label
            )}
          </CardDescription>
          <CardTitle
            className={cn(
              "flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-2xl tracking-tight",
              // An absent metric keeps the 2xl value slot — so the card doesn't
              // reflow, stays baseline-aligned with a sibling that has a value,
              // and never collapses into its own caption's size/colour — but
              // softens to the muted colour and a normal weight so it reads as
              // "nothing to show" rather than a bold value/rule (FEA-4236).
              noData && !loading
                ? "font-normal text-muted-foreground"
                : "font-semibold"
            )}
          >
            {renderMetricValue({
              loading,
              noData,
              unitLabel,
              value,
              valueUnavailableLabel,
            })}
          </CardTitle>
        </div>
        {placeholder ? (
          <Badge
            className="shrink-0 font-medium text-[10px] uppercase tracking-wide"
            variant="outline"
          >
            Sample
          </Badge>
        ) : null}
      </CardHeader>
      {hasFooter ? (
        <CardContent className="flex flex-col gap-2 pt-0">
          {showDelta ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <MetricDeltaChip
                capped={deltaCapped}
                delta={delta}
                polarity={deltaPolarity}
                sparkline={sparkline}
                treatment={deltaTreatment}
              />
              <MetricDeltaCaption
                delta={delta}
                deltaLabel={deltaLabel}
                polarity={deltaPolarity}
                treatment={deltaTreatment}
              />
            </div>
          ) : null}
          {showDeltaPlaceholder ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {deltaPlaceholder}
            </div>
          ) : null}
          {detail || trend ? (
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <span className="min-w-0 text-muted-foreground text-sm">
                {detail}
              </span>
              {trend ? (
                <span className="font-semibold text-primary text-xs">
                  {trend}
                </span>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

function renderMetricValue({
  loading,
  noData,
  unitLabel,
  value,
  valueUnavailableLabel,
}: {
  loading: boolean;
  noData: boolean;
  unitLabel: ReactNode;
  value: string | number | null | undefined;
  valueUnavailableLabel: ReactNode;
}) {
  if (loading) {
    // Skeleton ONLY the value, keeping the card's label/info/footer chrome —
    // never a bare grey slab beside fully-formed siblings. The height matches the
    // 2xl value line so the card doesn't reflow when the real value lands.
    return <Skeleton className="h-8 w-16 rounded" />;
  }
  if (noData) {
    // No unit is shown for an absent value — a "LOC/$" suffix beside "No data"
    // would imply a (missing) number it can't qualify.
    return <span className="min-w-0 break-words">{valueUnavailableLabel}</span>;
  }
  return (
    <>
      {/* `noData` above already returned for a nullish value, so this branch
          always has a real value; `?? ""` only satisfies the type narrowing. */}
      <span className="min-w-0 break-words">
        {formatMetricValue(value ?? "")}
      </span>
      {unitLabel ? (
        <span className="font-medium text-muted-foreground text-xs">
          {unitLabel}
        </span>
      ) : null}
    </>
  );
}

function MetricDeltaChip({
  delta,
  sparkline,
  polarity,
  capped = false,
  treatment,
}: {
  delta: number;
  sparkline?: Array<number | null | undefined>;
  polarity: MetricPolarity;
  capped?: boolean;
  treatment: MetricDeltaTreatment;
}) {
  // Direction and sentiment are separate readings (ISS-4633): the glyph says
  // which way the number moved (or that it held steady), the colour says whether
  // that is good for THIS metric. A rising spend keeps its honest up-arrow and
  // reads as a regression. NOTE: when a sparkline is available it replaces the
  // glyph, so the sentiment caption below is the only direction-independent cue.
  const rising = delta > 0;
  const flat = delta === 0;
  const sentiment = deltaSentiment(delta, polarity);
  // Render a real sparkline of the metric's trend when we have enough points;
  // otherwise fall back to the directional icon.
  const finitePoints = sparkline
    ? sparkline.filter(
        (value) => typeof value === "number" && Number.isFinite(value)
      ).length
    : 0;
  // Delegate the display string to the shared `formatDeltaPct` SSOT so a capped
  // magnitude reads as ">999%" / "<-999%" identically here and in the Insights
  // `TrendBadge` (FEA-3959/3960). `capped` from the caller marks a pre-clamped
  // value whose raw number is no longer meaningful; when set, the ceiling
  // treatment is applied even if the passed `delta` was already the ceiling.
  const label = capped
    ? formatDeltaPct(rising ? MAX_DELTA_PCT : -MAX_DELTA_PCT)
    : formatDeltaPct(delta);
  // Geometry and colour both come from the consumer's treatment (ISS-5842,
  // gated). Under `UnifiedPill` EVERY tone is a pill — same shape, same padding,
  // only the colour varies — because a neutral 0% that dropped to bare text made
  // a single row read as three components rather than one component in three
  // tonal states. Under `Legacy` (the default) neutral stays bare, so it cannot
  // be confused with the muted "No comparison" placeholder pill. Both branches
  // spend the SAME geometry constant, so no tone can acquire padding of its own.
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-medium text-[11px]",
        deltaPillGeometryClass(sentiment, treatment),
        deltaPillClass(sentiment, treatment)
      )}
      data-testid="metric-delta-chip"
    >
      {renderDeltaGlyph({ finitePoints, flat, rising, sparkline })}
      <span>{label}</span>
    </span>
  );
}

/**
 * The caption beside the delta chip: under `Legacy` a one-word verdict
 * ("better" / "worse") followed by the period label; under `UnifiedPill` the
 * period label alone.
 *
 * Which of the two applies — and the WCAG 2.2 SC 1.4.1 trade that dropping the
 * word makes, plus why the ISS-5842 treatment must not graduate until that trade
 * is adjudicated — is documented once on {@link deltaVerdictCaption}, so the two
 * delta families cannot describe the same decision two ways.
 */
function MetricDeltaCaption({
  delta,
  deltaLabel,
  polarity,
  treatment,
}: {
  delta: number;
  deltaLabel?: ReactNode;
  polarity: MetricPolarity;
  treatment: MetricDeltaTreatment;
}) {
  const verdict = deltaVerdictCaption(deltaSentiment(delta, polarity), treatment);
  if (!(verdict || deltaLabel)) {
    return null;
  }
  return (
    <span className="min-w-0 text-muted-foreground text-xs">
      {verdict ? <span className="font-medium">{verdict}</span> : null}
      {verdict && deltaLabel ? " " : null}
      {deltaLabel}
    </span>
  );
}

/**
 * The chip's leading mark: a real sparkline of the trend when there are enough
 * points, otherwise a glyph for the direction the number moved — including a
 * minus for a flat 0%, which is neither a rise nor a fall.
 */
function renderDeltaGlyph({
  finitePoints,
  flat,
  rising,
  sparkline,
}: {
  finitePoints: number;
  flat: boolean;
  rising: boolean;
  sparkline?: Array<number | null | undefined>;
}): ReactNode {
  if (finitePoints >= 2 && sparkline) {
    return (
      <Sparkline className="shrink-0" height={11} values={sparkline} width={26} />
    );
  }
  if (flat) {
    return <MinusIcon className="size-3" />;
  }
  if (rising) {
    return <TrendingUpIcon className="size-3" />;
  }
  return <TrendingDownIcon className="size-3" />;
}

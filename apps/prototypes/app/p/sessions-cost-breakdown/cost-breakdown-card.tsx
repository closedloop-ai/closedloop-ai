"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { InfoHint } from "@repo/design-system/components/ui/primitives/info-hint";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import {
  ChevronDown,
  MinusIcon,
  TrendingDownIcon,
  TrendingUpIcon,
} from "lucide-react";
import {
  allocateLaneRounding,
  formatCurrencyTileValue,
  formatCurrencyWhole,
  formatShare,
} from "./format";
import { COMPARISON_WINDOW_LABEL, type CostCohort } from "./mock";

// DS-GAP: local fork of the shared MetricCard primitive
// (packages/design-system/components/ui/primitives/metric-card.tsx). The gap
// this marker was opened for is CLOSED: MetricCard now ships a `lanes` slot
// (metric-card.tsx `lanes?: ReactNode`) with MetricCardLane/MetricCardLaneList,
// and production's CostMetricCard
// (packages/app/agents/components/sessions/cost-metric-card.tsx) already builds
// the reconciling lane list on it. What is left here is migration debt, not a
// design-system gap: the header below still reproduces MetricCard's structure
// INCLUDING its label join island (see LABEL_JOIN note), and the lanes sit
// behind a disclosure at every width rather than in MetricCard's footer slot.
// Before productionizing, rebuild this on the real MetricCard/CostMetricCard
// and delete this marker; nothing needs promoting into the design system
// first. See the DS-GAP note in .claude/skills/prototype/SKILL.md ("When no
// catalog component fits").

const CARD_LABEL = "Total estimated cost";

const CARD_INFO = {
  what: "Estimated cost across matched sessions, split by billing type.",
  how: "The sum of estimated actual API-billed costs, estimated subscription-covered costs, and unknown costs. API-billed is confirmed per-token spend. Subscription-covered is what that usage would have cost if metered. Billing unknown is the sum of costs with an undetermined billing method.",
};

/** Production's copy for a cohort where nothing could be priced. */
const NO_COST_RECORDED_DETAIL = "No cost recorded";

/**
 * Cost is lower-is-better, matching KPI_METRIC_POLARITY[InsightsKpiKey.Cost].
 * The chip ALWAYS carries a direction glyph, so the good/bad reading never rides
 * on hue alone (WCAG 1.4.1) — that matters more here than on the shipped card,
 * because this card drops the "better"/"worse" verdict word.
 */
const DeltaDirection = {
  Down: "down",
  Up: "up",
  Flat: "flat",
} as const;
type DeltaDirection = (typeof DeltaDirection)[keyof typeof DeltaDirection];

type Lane = {
  key: string;
  label: string;
  amount: number | null;
  muted: boolean;
  /** Why this lane is standing in for two, when the producer cannot split. */
  note?: string;
};

/** Tolerances the split must reconcile within before the card will report it. */
const SPLIT_ABSOLUTE_TOLERANCE = 0.01;
const SPLIT_RELATIVE_TOLERANCE = 1e-6;

/** A figure this card may stand behind: present, real, finite, not negative. */
function isReportableCostValue(
  value: number | null | undefined
): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

/**
 * Whether the producer sent a split this card can actually report, mirroring
 * production's `hasReportableCostSplit`.
 *
 * Presence of both halves is NOT enough. These values arrive over HTTP and over
 * Desktop IPC without being parsed, so a `null`, a non-finite, or a negative can
 * reach here despite the type — and two halves that do not reconcile with the
 * remainder they claim to partition are a producer bug or a version-skew shape
 * we do not understand. Reporting either would repair a bad payload into a
 * believable lane, or print `NaN` where money goes. Both fall back to the
 * two-lane presentation, which at least names the bucket it is summing.
 */
function hasReportableCostSplit(cohort: CostCohort): boolean {
  const metered = cohort.meteredEstimatedCost;
  const unknown = cohort.unknownEstimatedCost;
  if (!(isReportableCostValue(metered) && isReportableCostValue(unknown))) {
    return false;
  }
  if (
    !(
      isReportableCostValue(cohort.totalEstimatedCost) &&
      isReportableCostValue(cohort.subscriptionEstimatedCost)
    )
  ) {
    return false;
  }
  const remainder =
    cohort.totalEstimatedCost - cohort.subscriptionEstimatedCost;
  const drift = Math.abs(metered + unknown - remainder);
  const tolerance = Math.max(
    SPLIT_ABSOLUTE_TOLERANCE,
    Math.abs(remainder) * SPLIT_RELATIVE_TOLERANCE
  );
  return drift <= tolerance;
}

/**
 * The lanes for one cohort, or none. When the total is null nothing about the
 * split is knowable, so the card shows no lanes rather than printing a shape it
 * cannot fill — a `$0.00` lane under a "no cost recorded" headline is the same
 * fabricated zero this card exists to stop.
 */
function resolveLanes(cohort: CostCohort): readonly Lane[] {
  if (cohort.totalEstimatedCost === null) {
    return [];
  }
  const canSplit = hasReportableCostSplit(cohort);
  const subscription: Lane = {
    key: "subscription",
    label: "Subscription-covered",
    amount: cohort.subscriptionEstimatedCost,
    muted: false,
  };
  if (canSplit) {
    // Whole-dollar rounding is applied to the SET, not per lane: rounding each
    // independently leaves the column a dollar off the total above it, on a card
    // whose info copy promises they sum.
    const [api, sub, unknown] = allocateLaneRounding(
      [
        cohort.meteredEstimatedCost ?? null,
        cohort.subscriptionEstimatedCost,
        cohort.unknownEstimatedCost ?? null,
      ],
      cohort.totalEstimatedCost
    );
    return [
      {
        key: "api",
        label: "API-billed",
        amount: api ?? null,
        muted: false,
      },
      { ...subscription, amount: sub ?? null },
      {
        // "Billing unknown", never the bare "Unknown": the Sessions Cost FACET
        // already uses that word for the missing-cost population, which renders
        // a dash and contributes nothing. This lane is the opposite — real money
        // whose billing method was never determined.
        key: "billing-unknown",
        label: "Billing unknown",
        amount: unknown ?? null,
        // NOT muted (operator decision, 2026-08-26). The muted tone said "this
        // is a disclosure, not spend" — but on a subscription-heavy account it
        // is the WHOLE non-subscription bucket, and receding the one lane that
        // says "we could not determine this" is a softer version of the hiding
        // this card exists to undo.
        muted: false,
      },
    ];
  }
  const remainder =
    cohort.subscriptionEstimatedCost === null
      ? null
      : cohort.totalEstimatedCost - cohort.subscriptionEstimatedCost;
  return [
    subscription,
    {
      key: "remainder",
      label: "Not subscription-covered",
      amount: remainder,
      // Still muted, and NOT the same case as "Billing unknown" above: this
      // lane exists only because the producer cannot split the bucket, so it is
      // a stand-in for two lanes rather than a figure in its own right. Its
      // info hint says so.
      muted: true,
      note: "This producer cannot separate confirmed API spend from unclassified usage.",
    },
  ];
}

function resolveDeltaDirection(delta: number): DeltaDirection {
  if (delta > 0) {
    return DeltaDirection.Up;
  }
  return delta < 0 ? DeltaDirection.Down : DeltaDirection.Flat;
}

// The shared MetricCard chip's own glyphs, not a local substitute: the trending
// pair reads as movement over a period, which is what the chip reports, where a
// plain arrow reads as a single step up or down.
const DELTA_GLYPH = {
  [DeltaDirection.Up]: TrendingUpIcon,
  [DeltaDirection.Down]: TrendingDownIcon,
  [DeltaDirection.Flat]: MinusIcon,
} as const;

const LaneRow = ({ lane, total }: { lane: Lane; total: number | null }) => {
  const share = formatShare(lane.amount, total);
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt
        // WRAPS, never truncates. `truncate` is `overflow:hidden`, which clipped
        // the InfoHint out of the one lane that needs an explanation, in exactly
        // the width band where the label had stopped explaining itself. The value
        // column is a fixed `shrink-0` track, so a wrapping label can no longer
        // collide with the numbers — which is what forced the truncate.
        className={cn(
          "min-w-0 text-sm leading-snug",
          lane.muted ? "text-muted-foreground" : "text-foreground"
        )}
      >
        {lane.label}
        {lane.note ? (
          <InfoHint
            align="start"
            contentClassName="w-60 p-3 text-xs"
            label={`About ${lane.label}`}
            triggerClassName="-my-1 ml-1 h-6"
          >
            <p className="text-muted-foreground text-xs">{lane.note}</p>
          </InfoHint>
        ) : null}
      </dt>
      {/* Two fixed right-aligned tracks: the share column is the one a reader
          scans down to compare 99.9 against 0.1, so it cannot float wherever the
          amount beside it happens to end. */}
      <dd className="grid shrink-0 grid-cols-[3.25rem_5.5rem] items-baseline gap-2 text-right tabular-nums">
        <span className="text-muted-foreground text-xs">{share ?? ""}</span>
        <span className="text-foreground text-sm">
          {lane.amount === null ? "—" : formatCurrencyWhole(lane.amount)}
        </span>
      </dd>
    </div>
  );
};

const LaneList = ({
  lanes,
  total,
}: {
  lanes: readonly Lane[];
  total: number | null;
}) => (
  <dl className="flex flex-col gap-2">
    {lanes.map((lane) => (
      <LaneRow key={lane.key} lane={lane} total={total} />
    ))}
  </dl>
);

export const CostBreakdownCard = ({
  cohort,
  className,
}: {
  cohort: CostCohort;
  className?: string;
}) => {
  const loading = cohort.loading === true;
  const lanes = resolveLanes(cohort);
  const noTotal = cohort.totalEstimatedCost === null;
  const showLanes = loading || lanes.length > 0;
  // A card that declined to state its own VALUE drops the delta slot rather than
  // stacking a second negation under it — that rule is about the dashed-value
  // card and only that card. A card with a real total and no prior window still
  // owes the reader the no-comparison state, and a card still loading owes a
  // reserved slot so the chip cannot pop in and grow the card on settle.
  const showDeltaSlot = loading || !noTotal;
  return (
    <Card className={cn("border-border bg-card", className)}>
      <CardHeader className="flex min-w-0 flex-row items-start justify-between gap-4 space-y-0 pb-3">
        <div className="min-w-0 space-y-1">
          <CardDescription className="flex items-center gap-1.5 font-semibold text-[11px] uppercase tracking-[0.12em]">
            {/* LABEL JOIN ISLAND, carried over from MetricCard verbatim. Between
                roughly 206px and 225px of card width the trailing info glyph
                otherwise drops onto a line of its own, and the Sessions summary
                strip opens inside exactly that band. The `contents` spans keep
                the glyph joined to the label's last word without changing the
                label's own wrapping. */}
            <span className="contents whitespace-nowrap">
              <span className="contents whitespace-normal">{CARD_LABEL}</span>
              <InfoHint
                align="start"
                contentClassName="w-72 space-y-1 p-3 text-xs"
                label={`About ${CARD_LABEL}`}
                triggerClassName="-mx-1.5 -my-1 h-6"
              >
                <p className="font-medium text-xs">{CARD_INFO.what}</p>
                <p className="text-muted-foreground text-xs">{CARD_INFO.how}</p>
              </InfoHint>
            </span>
          </CardDescription>
          <CardTitle
            className={cn(
              "flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-2xl tracking-tight",
              noTotal && !loading
                ? "font-normal text-muted-foreground"
                : "font-semibold"
            )}
          >
            {loading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              formatCurrencyTileValue(cohort.totalEstimatedCost)
            )}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-0">
        {showDeltaSlot ? (
          <DeltaSlot delta={cohort.totalDeltaPercent} loading={loading} />
        ) : null}
        {noTotal && !loading ? (
          <span className="text-muted-foreground text-sm">
            {NO_COST_RECORDED_DETAIL}
          </span>
        ) : null}
        {showLanes ? (
          /* Behind the disclosure at EVERY width (operator decision,
             2026-08-26). This prototype used to carry a second, inline copy
             above a 19rem container query, and production shipped the same
             pair. Two things were wrong with it: the strip CAN reach that width
             (an `auto-fit` grid whose empty tracks collapse, so a >~2200px
             display or a hidden card widens the survivors), so the inline form
             was live rather than theoretical; and the prototype keyed the query
             off the CARD while production keyed it off the lane wrapper inside
             the card's padding, so the two flipped ~48px apart. Product chose
             one form over reconciling them. */
          <LaneBreakdownPopover
            lanes={lanes}
            loading={loading}
            total={cohort.totalEstimatedCost}
          />
        ) : null}
      </CardContent>
    </Card>
  );
};

const LaneBreakdownPopover = ({
  lanes,
  loading,
  total,
}: {
  lanes: readonly Lane[];
  loading: boolean;
  total: number | null;
}) => {
  if (loading) {
    return <Skeleton className="h-5 w-24" />;
  }
  return (
    <Popover>
      <PopoverTrigger className="-my-1 flex h-6 items-center gap-1 rounded-sm text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Cost breakdown
        <ChevronDown aria-hidden="true" className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <p className="pb-2 font-semibold text-[11px] uppercase tracking-[0.12em]">
          {CARD_LABEL}
        </p>
        <LaneList lanes={lanes} total={total} />
      </PopoverContent>
    </Popover>
  );
};

/**
 * The delta slot, resolving all three outcomes in one place so a card can never
 * silently drop it.
 */
const DeltaSlot = ({
  delta,
  loading,
}: {
  delta: number | null;
  loading: boolean;
}) => {
  if (loading) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-4 w-28" />
        {/* Every sentence available here is a verdict the read has not returned,
            so the pending state is announced rather than guessed at. */}
        <span className="sr-only">Comparison loading</span>
      </div>
    );
  }
  if (delta === null) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge
          className="border-transparent bg-foreground/5 font-medium text-[11px] text-muted-foreground"
          variant="outline"
        >
          No prior period
        </Badge>
      </div>
    );
  }
  return <DeltaRow delta={delta} />;
};

/**
 * The delta is on the TOTAL basis, matching the headline — not on the
 * not-subscription-covered bucket the shipped card grades, which is how a cohort
 * that merely moved onto subscription compute reads as 99% better.
 *
 * The visible "better" / "worse" word is gone (operator decision, Cosimo,
 * 2026-08-24). Two channels replace it, because colour alone cannot carry a
 * verdict: `--success` and `--destructive` sit at nearly the same lightness, so a
 * reader with a colour vision deficiency would otherwise see two identical chips.
 *   - The leading GLYPH is a distinct shape per state, carrying DIRECTION.
 *   - An sr-only verdict carries GOOD/BAD for assistive tech.
 * That second channel is the operator's recorded pick among the three
 * resolutions in `deltaVerdictCaption`'s docstring. It is the cheapest, and it
 * is honest about its limit: it does NOT reach a sighted reader with a colour
 * vision deficiency, for whom the tint remains the only verdict channel.
 * Dropping the sentiment colour entirely is the only resolution that closes it
 * for everyone.
 */
const DeltaRow = ({ delta }: { delta: number }) => {
  const direction = resolveDeltaDirection(delta);
  const Glyph = DELTA_GLYPH[direction];
  const toneClass = {
    [DeltaDirection.Up]: "bg-destructive/10 text-destructive",
    [DeltaDirection.Down]: "bg-success/10 text-success",
    [DeltaDirection.Flat]: "bg-foreground/5 text-muted-foreground",
  }[direction];
  // Cost is lower-is-better, so a fall is the improvement. A flat window makes
  // no claim at all rather than asserting a verdict on no movement.
  const verdict = {
    [DeltaDirection.Up]: "worse",
    [DeltaDirection.Down]: "better",
    [DeltaDirection.Flat]: null,
  }[direction];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Badge
        className={cn(
          "gap-1 border-transparent font-medium text-[11px] tabular-nums",
          toneClass
        )}
        variant="outline"
      >
        <Glyph aria-hidden="true" className="size-3" />
        {delta > 0 ? "+" : ""}
        {delta.toFixed(1)}%
        {verdict ? <span className="sr-only">{verdict}</span> : null}
      </Badge>
      <span className="text-muted-foreground text-sm">
        {COMPARISON_WINDOW_LABEL}
      </span>
    </div>
  );
};

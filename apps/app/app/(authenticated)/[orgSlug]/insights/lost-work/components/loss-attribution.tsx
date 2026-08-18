"use client";

import {
  LossClass,
  type LostWorkTotals,
} from "@repo/api/src/types/session-analytics";
import { Section } from "@repo/design-system/components/ui/layout/section";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { SegmentedBar } from "@repo/design-system/components/ui/primitives/segmented-bar";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  formatCount,
  formatHours,
  formatPercent,
  formatSessions,
  minutesToHours,
  toPercent,
} from "@/lib/analytics/format";
import { WidgetUnavailable } from "@/lib/analytics/unavailable";
import { LOSS_CLASS_BAR_CLASS } from "./loss-palette";

/**
 * The top of the screen, and the one place the systemic/behavioral split has to
 * be unmistakable.
 *
 * The layout, not a footnote, carries the argument: the coachable number gets
 * its own card at the headline size, and everything the engineer did not cause
 * sits in a separate, lower-emphasis panel beside it under a heading that says
 * so. There is deliberately NO combined "total lost" figure anywhere on the
 * strip. An org-wide usage-limit day would inflate it, and the person who
 * simply worked the most that day would top the list.
 *
 * The denominator lives on the same screen as every rate: the composition
 * section below shows all of the window's wall-clock, so a loss figure is
 * always read against the work it came out of.
 */

export const TOTALS_UNAVAILABLE_REASON =
  "The session rollup did not load for this range, so these figures are unavailable rather than zero.";

const COMPOSITION_SKELETON_CLASS = "h-24 w-full rounded-md";

type LossAttributionProps = {
  readonly loading: boolean;
  /** `null` when the totals rollup settled without a value. Never a zeroed stub. */
  readonly totals: LostWorkTotals | null;
};

export function LossAttribution({ loading, totals }: LossAttributionProps) {
  const actionableMinutes =
    totals?.minutesByClass[LossClass.Actionable] ?? null;
  const unavailable = !(loading || totals);

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <MetricCard
        className="lg:col-span-5 lg:self-start"
        detail={resolveActionableDetail(loading, totals)}
        info={{
          how: "A session that ended with a recorded error and produced no artifact, with no platform throttle behind it.",
          what: "Wall-clock lost to failures the engineer can act on.",
        }}
        label="Actionable loss"
        loading={loading}
        // A dimmed card with a reason, never a zero: `muted` is the design
        // system's own affordance for a read that failed, as distinct from
        // `placeholder` (demo data) and from a real measured 0.
        muted={unavailable}
        value={
          actionableMinutes === null
            ? null
            : formatHours(minutesToHours(actionableMinutes))
        }
      />
      <Section
        className="lg:col-span-7"
        description="Shown beside the coachable number, never added into it."
        title="Not attributable to the engineer"
      >
        <dl className="divide-y divide-border">
          <UnattributedRow
            caption="Rate limit, usage limit, or provider API error recorded against the run."
            loading={loading}
            minutes={totals?.minutesByClass[LossClass.Systemic] ?? null}
            sessions={totals?.sessionsByClass[LossClass.Systemic] ?? null}
            term="Systemic"
          />
          <UnattributedRow
            caption="No outcome was ever recorded, so the cause is not guessed into either side."
            loading={loading}
            minutes={totals?.minutesByClass[LossClass.Unattributed] ?? null}
            sessions={totals?.sessionsByClass[LossClass.Unattributed] ?? null}
            term="Unattributed"
          />
        </dl>
      </Section>
      <Section
        className="lg:col-span-12"
        description={resolveCompositionDescription(loading, totals)}
        title="Where the wall-clock went"
      >
        <CompositionBar loading={loading} totals={totals} />
      </Section>
    </div>
  );
}

function CompositionBar({
  loading,
  totals,
}: {
  readonly loading: boolean;
  readonly totals: LostWorkTotals | null;
}) {
  if (loading) {
    return <Skeleton className={COMPOSITION_SKELETON_CLASS} />;
  }
  if (!totals) {
    return <WidgetUnavailable reason={TOTALS_UNAVAILABLE_REASON} />;
  }
  const segments = buildCompositionSegments(totals);
  return (
    <SegmentedBar
      segments={segments}
      // The PARTS define the whole. Passing a separately-derived grand total
      // let the four segments sum to 265 under a total of 266, so the bar's own
      // percentages added to 101 and every segment was drawn a hair short. A
      // composition bar has to reconcile with itself.
      total={segments.reduce((sum, segment) => sum + segment.value, 0)}
    />
  );
}

function UnattributedRow({
  term,
  minutes,
  sessions,
  caption,
  loading,
}: {
  readonly term: string;
  /** `null` is settled-unavailable. A real `0` is a measurement and renders as one. */
  readonly minutes: number | null;
  readonly sessions: number | null;
  readonly caption: string;
  readonly loading: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <dt className="font-medium text-sm">{term}</dt>
        <dd className="text-muted-foreground text-xs">{caption}</dd>
      </div>
      <dd className="shrink-0 text-right">
        {loading ? (
          <Skeleton className="h-6 w-16 rounded" />
        ) : (
          <span className="font-semibold text-lg">
            {formatHours(minutes === null ? null : minutesToHours(minutes))}
          </span>
        )}
        {loading ? (
          <Skeleton className="mt-1 ml-auto h-4 w-20 rounded" />
        ) : (
          <div className="text-muted-foreground text-xs">
            {formatSessions(sessions)}
          </div>
        )}
      </dd>
    </div>
  );
}

/**
 * The window's wall-clock split into productive time plus the three loss
 * classes.
 *
 * `value` carries the UNROUNDED hours, because it is what the bar's geometry
 * and its own percentages are computed from — rounding each class to whole
 * hours first made a class with 25 minutes lost collapse to `0`, which drops it
 * out of the bar entirely while the panel eight pixels above still reports
 * "0.4 h" for the same fact. `formattedValue` carries the same one-decimal hour
 * string every other hour on this screen uses, so the legend reads in the unit
 * the section is about instead of as a bare number.
 */
function buildCompositionSegments(totals: LostWorkTotals) {
  const hoursSegment = (
    key: string,
    label: string,
    colorClassName: string,
    minutes: number
  ) => {
    const hours = minutesToHours(minutes);
    return {
      colorClassName,
      formattedValue: formatHours(hours),
      key,
      label,
      value: hours,
    };
  };
  return [
    hoursSegment(
      "productive",
      "Produced an artifact",
      LOSS_CLASS_BAR_CLASS.productive,
      totals.productiveMinutes
    ),
    hoursSegment(
      LossClass.Actionable,
      "Actionable loss",
      LOSS_CLASS_BAR_CLASS[LossClass.Actionable],
      totals.minutesByClass[LossClass.Actionable]
    ),
    hoursSegment(
      LossClass.Systemic,
      "Systemic loss",
      LOSS_CLASS_BAR_CLASS[LossClass.Systemic],
      totals.minutesByClass[LossClass.Systemic]
    ),
    hoursSegment(
      LossClass.Unattributed,
      "Unattributed",
      LOSS_CLASS_BAR_CLASS[LossClass.Unattributed],
      totals.minutesByClass[LossClass.Unattributed]
    ),
  ];
}

function resolveActionableDetail(
  loading: boolean,
  totals: LostWorkTotals | null
): string {
  if (loading) {
    return "Reading sessions";
  }
  if (!totals) {
    return TOTALS_UNAVAILABLE_REASON;
  }
  const sessions = totals.sessionsByClass[LossClass.Actionable];
  const rate = toPercent(sessions, totals.sessionCount);
  return `${formatCount(sessions)} of ${formatCount(totals.sessionCount)} sessions, a ${formatPercent(rate)} loss rate`;
}

function resolveCompositionDescription(
  loading: boolean,
  totals: LostWorkTotals | null
): string {
  if (loading || !totals) {
    return "Every session in range, split by whether it produced an artifact.";
  }
  return `${formatCount(totals.sessionCount)} sessions, ${formatHours(minutesToHours(totals.totalMinutes))} of session wall-clock in range.`;
}

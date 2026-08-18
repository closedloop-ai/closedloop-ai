"use client";

import { Section } from "@repo/design-system/components/ui/layout/section";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { SegmentedBar } from "@repo/design-system/components/ui/primitives/segmented-bar";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  DataState,
  formatCount,
  formatHours,
  formatPercent,
  formatSessions,
} from "@/lib/analytics/format";
import { LossClass } from "@/lib/analytics/session-fixture";
import {
  actionableHours,
  actionableRatePct,
  lossTotals,
  productiveHours,
  systemicHours,
  totalHours,
  unattributedHours,
} from "../mock";
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
 * The denominator lives on the same screen as every rate: the section below
 * shows all of the window's wall-clock, so a loss figure is always read against
 * the work it came out of.
 */

/**
 * The window's wall-clock split into productive time plus the three loss
 * classes. Rounded to whole hours once, here, so every consumer reads the same
 * numbers.
 */
const COMPOSITION_SEGMENTS = [
  {
    colorClassName: LOSS_CLASS_BAR_CLASS.productive,
    key: "productive",
    label: "Produced an artifact",
    value: Math.round(productiveHours()),
  },
  {
    colorClassName: LOSS_CLASS_BAR_CLASS[LossClass.Actionable],
    key: LossClass.Actionable,
    label: "Actionable loss",
    value: Math.round(actionableHours()),
  },
  {
    colorClassName: LOSS_CLASS_BAR_CLASS[LossClass.Systemic],
    key: LossClass.Systemic,
    label: "Systemic loss",
    value: Math.round(systemicHours()),
  },
  {
    colorClassName: LOSS_CLASS_BAR_CLASS[LossClass.Unattributed],
    key: LossClass.Unattributed,
    label: "Unattributed",
    value: Math.round(unattributedHours()),
  },
];

type LossAttributionProps = {
  readonly dataState: DataState;
};

export function LossAttribution({ dataState }: LossAttributionProps) {
  const loading = dataState === DataState.Loading;
  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <MetricCard
        className="lg:col-span-5 lg:self-start"
        detail={
          loading
            ? "Reading sessions"
            : `${formatCount(lossTotals.sessionsByClass[LossClass.Actionable])} of ${formatCount(lossTotals.sessionCount)} sessions, a ${formatPercent(actionableRatePct())} loss rate`
        }
        info={{
          how: "A session that ended with a recorded error and produced no artifact, with no platform throttle behind it.",
          what: "Wall-clock lost to failures the engineer can act on.",
        }}
        label="Actionable loss"
        loading={loading}
        value={formatHours(actionableHours())}
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
            sessions={lossTotals.sessionsByClass[LossClass.Systemic]}
            term="Systemic"
            value={systemicHours()}
          />
          <UnattributedRow
            caption="No outcome was ever recorded, so the cause is not guessed into either side."
            loading={loading}
            sessions={lossTotals.sessionsByClass[LossClass.Unattributed]}
            term="Unattributed"
            value={unattributedHours()}
          />
        </dl>
      </Section>
      <Section
        className="lg:col-span-12"
        description={`${formatCount(lossTotals.sessionCount)} sessions, ${formatHours(totalHours())} of session wall-clock in range.`}
        title="Where the wall-clock went"
      >
        {loading ? (
          <Skeleton className="h-24 w-full rounded-md" />
        ) : (
          <SegmentedBar
            segments={COMPOSITION_SEGMENTS}
            // The rounded PARTS define the whole. Passing the separately-rounded
            // grand total let the four segments sum to 265 under a total of 266,
            // so the bar's own percentages added to 101 and every segment was
            // drawn a hair short. A composition bar has to reconcile with itself.
            total={COMPOSITION_SEGMENTS.reduce(
              (sum, segment) => sum + segment.value,
              0
            )}
          />
        )}
      </Section>
    </div>
  );
}

function UnattributedRow({
  term,
  value,
  sessions,
  caption,
  loading,
}: {
  readonly term: string;
  readonly value: number;
  readonly sessions: number;
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
          <span className="font-semibold text-lg">{formatHours(value)}</span>
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

"use client";

import {
  AnalyticsRangeToggle,
  type AnalyticsRangeToggleOption,
} from "@repo/design-system/components/ui/analytics-range-toggle";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { useState } from "react";
import {
  badges,
  contributionHeatmap,
  DEFAULT_RANGE,
  HeadlineMetricKey,
  headlineMetricsFor,
  isRangeDays,
  person,
  personalBests,
  RANGE_COPY,
  RangeDays,
  ranks,
  streakBest,
  streakDays,
  tokenBreakdownFor,
} from "../mock";
import { HeatmapCard, TokenBreakdownCard } from "./charts";
import {
  AchievementBadge,
  PersonalBestRow,
  RankTile,
  SecondaryMetricsRow,
  StreakTile,
} from "./flair";
import { ProfileHeader } from "./profile-header";
import { WidgetCard } from "./widget-card";

// The in-app profile page: the /<org>/users/[userId] vision. Headline power
// numbers up top, then flair (rank/streak/milestones), then the two substance
// widgets a brag wall keeps — the token donut and the year-long contribution
// graph. Every widget is a design-system primitive fed mock data.

// The Insights overview bumps its headline MetricCard value to text-3xl via a
// shared class so the numbers the visitor came to see are the largest type on
// the page. Prototypes can't import @repo/app, so the same delta is inlined.
const METRIC_CARD_CLASS_NAME = "[&_[data-slot='card-title']]:text-3xl";

// Which 2-3 metrics are the actual headline (#4285 review: six co-equal cards
// gave the eye no entry point). PRs shipped and Tokens used are what a
// visitor came for; Autonomy index is the one framing metric worth the same
// weight. Efficiency, Model spend, and Avg concurrency are real but
// inside-baseball on a brag wall — they still render, just demoted to a
// plain row via SecondaryMetricsRow below.
const PRIMARY_METRIC_KEYS: readonly HeadlineMetricKey[] = [
  HeadlineMetricKey.PrsShipped,
  HeadlineMetricKey.TokensTotal,
  HeadlineMetricKey.Autonomy,
];

// The range control drives the page: the section caption, every delta caption,
// and the window-dependent figures all derive from the selected value, so the
// toggle never leaves the copy asserting a window the user did not pick.
const RANGE_OPTIONS: AnalyticsRangeToggleOption[] = [
  { label: "30d", value: RangeDays.Month },
  { label: "90d", value: RangeDays.Quarter },
  { label: "1y", value: RangeDays.Year },
];

function formatContribution(count: number): string {
  const noun = count === 1 ? "merged PR" : "merged PRs";
  return `${count.toLocaleString()} ${noun}`;
}

export function ProfilePage({ onShare }: { onShare: () => void }) {
  const [range, setRange] = useState<RangeDays>(DEFAULT_RANGE);
  const copy = RANGE_COPY[range];
  const metrics = headlineMetricsFor(range);
  const primaryMetrics = metrics.filter((metric) =>
    PRIMARY_METRIC_KEYS.includes(metric.key)
  );
  const secondaryMetrics = metrics.filter(
    (metric) => !PRIMARY_METRIC_KEYS.includes(metric.key)
  );

  const handleRangeChange = (value: string) => {
    if (isRangeDays(value)) {
      setRange(value);
    }
  };

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 p-6">
      <ProfileHeader onShare={onShare} person={person} />

      {/* Headline power numbers, the thing the visitor came to see. The range
          control lives here rather than at the page level (#4285 review):
          this is the only section it actually drives — Standing, Milestones,
          and the contribution graph are lifetime facts that don't move with
          it. */}
      <section aria-labelledby="headline-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            className="font-semibold text-lg tracking-tight"
            id="headline-heading"
          >
            Headlines
            <span className="ml-2 font-medium text-muted-foreground text-sm">
              · {copy.window}
            </span>
          </h2>
          <AnalyticsRangeToggle
            onValueChange={handleRangeChange}
            options={RANGE_OPTIONS}
            value={range}
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {primaryMetrics.map((metric) => (
            <MetricCard
              className={METRIC_CARD_CLASS_NAME}
              delta={metric.delta}
              deltaLabel={copy.delta}
              // Which direction is good is per-metric, not one blanket
              // "higher is better" for every card (#4285 review / ISS-4633):
              // a rising bill and rising raw token volume are not wins.
              deltaPolarity={metric.polarity}
              detail={metric.detail}
              info={metric.info}
              key={metric.key}
              label={metric.label}
              sparkline={metric.sparkline}
              unitLabel={metric.unitLabel}
              value={metric.value}
            />
          ))}
        </div>
        <SecondaryMetricsRow
          deltaLabel={copy.delta}
          metrics={secondaryMetrics}
        />
      </section>

      {/* Flair: rank vs org and global, plus the current streak. Lifetime
          standing, not scoped to the Headlines range control. */}
      <section aria-labelledby="standing-heading" className="space-y-3">
        <h2
          className="font-semibold text-lg tracking-tight"
          id="standing-heading"
        >
          Standing
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ranks.map((rank) => (
            <RankTile key={rank.scope} rank={rank} />
          ))}
          <StreakTile best={streakBest} current={streakDays} />
        </div>
      </section>

      {/* Substance: the token breakdown for the selected range, and the
          year-long contribution graph (deliberately always a full year, so
          it does not double as a second, redundant range-scoped widget). */}
      <section aria-labelledby="activity-heading" className="space-y-3">
        <h2
          className="font-semibold text-lg tracking-tight"
          id="activity-heading"
        >
          Activity
        </h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <TokenBreakdownCard
            data={tokenBreakdownFor(range)}
            windowLabel={copy.window}
          />
          <HeatmapCard
            description="Merged pull requests per day"
            title="Contribution graph · last year"
            valueFormatter={formatContribution}
            weeks={contributionHeatmap}
          />
        </div>
      </section>

      {/* Achievements + personal bests, matching plain-row treatments. */}
      <section aria-labelledby="milestones-heading" className="space-y-3">
        <h2
          className="font-semibold text-lg tracking-tight"
          id="milestones-heading"
        >
          Milestones
        </h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <WidgetCard
            description="Lifetime milestones earned across all your sessions"
            title="Achievements"
          >
            <div className="divide-y divide-border">
              {badges.map((badge) => (
                <AchievementBadge badge={badge} key={badge.key} />
              ))}
            </div>
          </WidgetCard>
          <WidgetCard
            description="Records set across all your sessions"
            title="Personal Bests"
          >
            <div className="divide-y divide-border">
              {personalBests.map((best) => (
                <PersonalBestRow best={best} key={best.key} />
              ))}
            </div>
          </WidgetCard>
        </div>
      </section>
    </main>
  );
}

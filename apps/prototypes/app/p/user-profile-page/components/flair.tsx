"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Card, CardContent } from "@repo/design-system/components/ui/card";
import {
  DELTA_SENTIMENT_TEXT_CLASS,
  deltaSentiment,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import { cn } from "@repo/design-system/lib/utils";
import { FlameIcon } from "lucide-react";
import type {
  Badge as BadgeData,
  HeadlineMetric,
  PersonalBest,
  RankStat,
} from "../mock";
import { BADGE_ICONS, TONE_TEXT_CLASS } from "./badge-styles";

// Rank, streak, achievement badges, and personal bests. Restrained, not gaudy:
// one warm accent per tone, no rainbow, tokenized colors only, and milestone
// achievements share the same plain-row treatment as Personal Bests beside them.

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${n}th`;
  }
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function RankTile({ rank }: { rank: RankStat }) {
  const scopeLabel = rank.scope === "org" ? "Org rank" : "Global rank";
  return (
    <Card className="border-border bg-card">
      <CardContent className="flex items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <div className="min-w-0 space-y-1">
          <p className="font-semibold text-muted-foreground text-xs uppercase tracking-[0.12em]">
            {scopeLabel}
          </p>
          <p className="flex items-baseline gap-1.5 font-semibold text-3xl tracking-tight">
            {ordinal(rank.rank)}
            <span className="font-medium text-muted-foreground text-sm">
              of {rank.population.toLocaleString()}
            </span>
          </p>
          <p className="text-muted-foreground text-sm">
            {rank.metric} {rank.label}
          </p>
        </div>
        {/* One tone for "rank" across scopes; the eyebrow ("Org rank" /
            "Global rank") carries the org-vs-global distinction, so the badge
            does not also split its color by scope. */}
        <Badge className="shrink-0 font-semibold text-xs" variant="accent">
          Top {rank.percentile}%
        </Badge>
      </CardContent>
    </Card>
  );
}

export function StreakTile({
  current,
  best,
}: {
  current: number;
  best: number;
}) {
  return (
    <Card className="border-border bg-card">
      <CardContent className="flex items-center gap-2 px-4 py-4 sm:px-6">
        <div className="min-w-0 space-y-1">
          <p className="flex items-center gap-1.5 font-semibold text-muted-foreground text-xs uppercase tracking-[0.12em]">
            <FlameIcon
              aria-hidden="true"
              className="size-3.5 text-destructive"
            />
            Current streak
          </p>
          <p className="flex items-baseline gap-1.5 font-semibold text-3xl tracking-tight">
            {current}
            <span className="font-medium text-muted-foreground text-sm">
              days
            </span>
          </p>
          <p className="text-muted-foreground text-sm">
            Personal best {best} days
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function AchievementBadge({ badge }: { badge: BadgeData }) {
  const Icon = BADGE_ICONS[badge.icon];
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm">
          <Icon
            aria-hidden="true"
            className={cn("size-3.5 shrink-0", TONE_TEXT_CLASS[badge.tone])}
          />
          <span className="truncate">{badge.title}</span>
        </p>
        <p className="text-muted-foreground text-xs">{badge.detail}</p>
      </div>
      <p className="shrink-0 text-muted-foreground text-xs">
        {badge.earnedLabel}
      </p>
    </div>
  );
}

export function PersonalBestRow({ best }: { best: PersonalBest }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm">{best.label}</p>
        <p className="text-muted-foreground text-xs">{best.when}</p>
      </div>
      <p className="shrink-0 font-semibold text-base tracking-tight">
        {best.value}
      </p>
    </div>
  );
}

// The Headlines grid promotes only the 2-3 metrics a visitor came for; the
// rest (Efficiency, Model spend, Avg concurrency — inside-baseball on a brag
// wall) still belong on the page, just not co-equal with the headline. One
// shared Card in the same "plain row" register as RankTile/StreakTile above,
// not a second grid of boxed cards.
export function SecondaryMetricsRow({
  metrics,
  deltaLabel,
}: {
  metrics: HeadlineMetric[];
  deltaLabel: string;
}) {
  return (
    <Card className="border-border bg-card">
      <CardContent className="flex flex-wrap gap-x-8 gap-y-4 px-4 py-4 sm:px-6">
        {metrics.map((metric) => (
          <SecondaryMetricStat
            deltaLabel={deltaLabel}
            key={metric.key}
            metric={metric}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function SecondaryMetricStat({
  metric,
  deltaLabel,
}: {
  metric: HeadlineMetric;
  deltaLabel: string;
}) {
  const sentiment = deltaSentiment(metric.delta, metric.polarity);
  const sign = metric.delta > 0 ? "+" : "";
  return (
    <div className="min-w-32 flex-1 space-y-1">
      <p className="font-semibold text-muted-foreground text-xs uppercase tracking-[0.12em]">
        {metric.label}
      </p>
      <p className="flex items-baseline gap-1 font-semibold text-xl tracking-tight">
        {metric.value}
        {metric.unitLabel ? (
          <span className="font-medium text-muted-foreground text-xs">
            {metric.unitLabel}
          </span>
        ) : null}
      </p>
      {/* ISS-5842: no verdict word — the tone carries the reading, matching the
          Headlines MetricCard delta chip, which no longer editorialises either. */}
      <p
        className={cn(
          "flex flex-wrap items-baseline gap-x-1 text-xs",
          DELTA_SENTIMENT_TEXT_CLASS[sentiment]
        )}
      >
        <span>
          {sign}
          {metric.delta}%
        </span>
        <span className="text-muted-foreground">{deltaLabel}</span>
      </p>
    </div>
  );
}

"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { CategoryBarChart } from "@repo/design-system/components/ui/category-bar-chart";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { ActivityIcon, Clock3Icon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { DashboardTourTarget } from "./dashboard-spotlight-tour";
import { useFtueProgress } from "./ftue-progress-context";
import { useWebMasterPrototype } from "./web-master-prototype-context";

const rangeOptions = ["7d", "30d", "90d", "All"] as const;

type DashboardRange = (typeof rangeOptions)[number];

// Each window is hand-authored rather than scaled from 7d: a multiplier over a
// cumulative total invents growth the mock never had, and the long windows are
// capped because this workspace only has about four months of history
// (apps/prototypes/AGENTS.md, "Mocks must be derivable from the real source").
// Producer for every field: the Insights rollup the Dashboard already reads
// (sessions + spend from the local analyzer, PR figures from the GitHub link).
type DashboardWindow = {
  days: number;
  sessions: number;
  spendUsd: number;
  mergedPrs: number;
  averagePrSize: number;
  locMerged: number;
  locPerDollar: number;
  claudeSpendUsd: number;
  codexSpendUsd: number;
  electronPrs: number;
  symphonyPrs: number;
  busyStride: number;
};

const RANGE_CONFIG: Record<DashboardRange, DashboardWindow> = {
  "7d": {
    days: 7,
    sessions: 270,
    spendUsd: 825,
    mergedPrs: 24,
    averagePrSize: 38,
    locMerged: 52_000,
    locPerDollar: 52,
    claudeSpendUsd: 610,
    codexSpendUsd: 215,
    electronPrs: 15,
    symphonyPrs: 9,
    busyStride: 4,
  },
  "30d": {
    days: 30,
    sessions: 812,
    spendUsd: 2940,
    mergedPrs: 78,
    averagePrSize: 41,
    locMerged: 168_000,
    locPerDollar: 57,
    claudeSpendUsd: 2180,
    codexSpendUsd: 760,
    electronPrs: 44,
    symphonyPrs: 27,
    busyStride: 3,
  },
  "90d": {
    days: 90,
    sessions: 1960,
    spendUsd: 7150,
    mergedPrs: 181,
    averagePrSize: 44,
    locMerged: 402_000,
    locPerDollar: 56,
    claudeSpendUsd: 5290,
    codexSpendUsd: 1860,
    electronPrs: 98,
    symphonyPrs: 61,
    busyStride: 2,
  },
  All: {
    days: 118,
    sessions: 2418,
    spendUsd: 8760,
    mergedPrs: 219,
    averagePrSize: 44,
    locMerged: 487_000,
    locPerDollar: 56,
    claudeSpendUsd: 6480,
    codexSpendUsd: 2280,
    electronPrs: 119,
    symphonyPrs: 74,
    busyStride: 2,
  },
};

const emptyMetrics = [
  {
    label: "Sessions",
    detail: "No sessions synced yet",
    info: "Agent sessions in the selected range.",
  },
  {
    label: "AI spend",
    detail: "No priced usage yet",
    info: "Estimated model cost in the selected range.",
  },
  {
    label: "PRs shipped",
    detail: "No merged PRs yet",
    info: "Pull requests merged in the selected range.",
  },
  {
    label: "PR size",
    detail: "No merged lines yet",
    info: "Average merged pull-request size.",
  },
  {
    label: "Merged LOC",
    detail: "No merged lines yet",
    info: "Lines merged in the selected range.",
  },
] as const;

const aiImpactMetrics = [
  ["Cost", "No model cost yet"],
  ["PRs shipped", "No merged PRs yet"],
  ["LOC / $", "No delivery data yet"],
  ["Top repository", "No merged PRs yet"],
] as const;

export function DashboardEmptySurface() {
  const [range, setRange] = useState<DashboardRange>("7d");
  const { progress } = useFtueProgress();
  const { githubConnected, mode, openGitHubSetup, organizationHasSessionData } =
    useWebMasterPrototype();
  const effectiveProgress =
    mode === "web" && organizationHasSessionData ? 100 : progress;
  const deliveryDataAvailable =
    githubConnected || (mode === "web" && organizationHasSessionData);
  const rangeWindow = RANGE_CONFIG[range];
  // Analysis progress is how much of the window has been read so far; the window
  // itself supplies the totals.
  const analyzedShare = effectiveProgress / 100;
  const parsedSessions = Math.round(rangeWindow.sessions * analyzedShare);
  const metricValues: (string | null)[] = [
    effectiveProgress > 0 ? parsedSessions.toLocaleString("en-US") : null,
    effectiveProgress >= 20
      ? `$${Math.round(rangeWindow.spendUsd * analyzedShare)}`
      : null,
    deliveryDataAvailable && effectiveProgress >= 48
      ? String(Math.max(1, Math.round(rangeWindow.mergedPrs * analyzedShare)))
      : null,
    deliveryDataAvailable && effectiveProgress >= 62
      ? String(Math.round(rangeWindow.averagePrSize * analyzedShare))
      : null,
    deliveryDataAvailable && effectiveProgress >= 72
      ? Math.round(rangeWindow.locMerged * analyzedShare).toLocaleString(
          "en-US"
        )
      : null,
  ];
  const hasShippedPr = metricValues[2] !== null;
  const impactValues = [
    metricValues[1],
    metricValues[2],
    hasShippedPr
      ? String(Math.round(rangeWindow.locPerDollar * analyzedShare))
      : null,
    hasShippedPr ? "closedloop-electron" : null,
  ];
  const parsedRows = Math.min(4, Math.floor(effectiveProgress / 18));
  const modelPoints = buildModelPoints(effectiveProgress, range);
  const prPoints = buildPrPoints(effectiveProgress, range);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-5">
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-semibold text-2xl tracking-tight">Dashboard</h1>
            <p className="mt-1 text-muted-foreground text-sm">
              Agent-session telemetry across your synced compute targets.
            </p>
          </div>
          <ToggleGroup
            aria-label="Date range"
            onValueChange={(value) => {
              if (value) {
                setRange(value as (typeof rangeOptions)[number]);
              }
            }}
            size="sm"
            type="single"
            value={range}
            variant="outline"
          >
            {rangeOptions.map((option) => (
              <ToggleGroupItem key={option} value={option}>
                {option}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div
          className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-3 xl:grid-cols-5"
          data-dashboard-tour={DashboardTourTarget.Stats}
        >
          {emptyMetrics.map((metric, index) => (
            <MetricCard
              className="h-full [&_[data-slot='card-title']]:text-3xl"
              detail={getMetricDetail({
                emptyDetail: metric.detail,
                githubConnected,
                hasValue: metricValues[index] !== null,
                index,
                onConnect: openGitHubSetup,
              })}
              info={{ what: metric.info }}
              key={metric.label}
              label={metric.label}
              value={metricValues[index]}
            />
          ))}
        </div>

        <DashboardCard
          description="How spend translates into shipped value"
          title="AI Impact"
          tourTarget={DashboardTourTarget.Impact}
        >
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {aiImpactMetrics.map(([label, detail], index) => (
              <div className="space-y-1" key={label}>
                <p className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
                  {label}
                </p>
                <p className="font-semibold text-2xl tracking-tight transition-all duration-500">
                  {impactValues[index] ?? "No data"}
                </p>
                <p className="text-muted-foreground text-sm">
                  {impactValues[index] === null
                    ? detail
                    : "Computed from imported sessions"}
                </p>
              </div>
            ))}
          </div>
        </DashboardCard>

        <DashboardCard
          description="Each agent run and human input in the selected range"
          title="Event Activity"
          tourTarget={DashboardTourTarget.Activity}
        >
          {effectiveProgress < 8 ? (
            <EmptyState
              className="min-h-52 py-8"
              description="Activity will appear after your first agent session is discovered."
              icon={ActivityIcon}
              title="No activity yet"
            />
          ) : (
            <ActivityPreview progress={effectiveProgress} range={range} />
          )}
        </DashboardCard>

        <DashboardCard
          description="Always last 7 days · latest synced agent runs"
          title="Recent Sessions"
          tourTarget={DashboardTourTarget.Sessions}
        >
          {parsedRows === 0 ? (
            <EmptyState
              className="min-h-52 py-8"
              description="No synced sessions have arrived yet."
              icon={Clock3Icon}
              title="No recent sessions"
            />
          ) : (
            <RecentSessionsPreview count={parsedRows} />
          )}
        </DashboardCard>

        <DashboardCard
          description="Model spend over time"
          fixedHeightClassName="h-[300px]"
          title="Model cost over time"
          tourTarget={DashboardTourTarget.Models}
        >
          <TimeSeriesAreaChart
            emptyMessage="No model cost yet"
            points={modelPoints}
            series={modelSeries}
          />
        </DashboardCard>

        <DashboardCard
          description="Pull requests merged over time"
          fixedHeightClassName="h-[300px]"
          title="PR throughput"
          tourTarget={DashboardTourTarget.PullRequests}
        >
          <TimeSeriesAreaChart
            emptyMessage="No merged PRs yet"
            points={prPoints}
            series={prSeries}
          />
        </DashboardCard>

        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
          <DashboardCard
            description="Total spend by model"
            fixedHeightClassName="h-64"
            title="Spend by model"
          >
            <CategoryBarChart
              data={
                effectiveProgress >= 55
                  ? [
                      {
                        key: "claude",
                        label: "Claude",
                        value: Math.round(
                          rangeWindow.claudeSpendUsd * analyzedShare
                        ),
                      },
                      {
                        key: "codex",
                        label: "Codex",
                        value: Math.round(
                          rangeWindow.codexSpendUsd * analyzedShare
                        ),
                      },
                    ]
                  : []
              }
              emptyMessage="No model spend yet"
              horizontal
            />
          </DashboardCard>
          <DashboardCard
            description="Merged pull requests by repository"
            fixedHeightClassName="h-64"
            title="PRs by repository"
          >
            <CategoryBarChart
              data={
                effectiveProgress >= 68
                  ? [
                      {
                        key: "electron",
                        label: "closedloop-electron",
                        value: Math.max(
                          1,
                          Math.round(rangeWindow.electronPrs * analyzedShare)
                        ),
                      },
                      {
                        key: "symphony",
                        label: "symphony",
                        value: Math.max(
                          1,
                          Math.round(rangeWindow.symphonyPrs * analyzedShare)
                        ),
                      },
                    ]
                  : []
              }
              emptyMessage="No merged PRs yet"
              horizontal
            />
          </DashboardCard>
        </div>
      </div>
    </div>
  );
}

function GitHubMetricPrompt({ onConnect }: { onConnect: () => void }) {
  return (
    <span className="text-xs leading-5">
      <button
        className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
        onClick={onConnect}
        type="button"
      >
        Connect to GitHub
      </button>{" "}
      to see sessions tied to PRs.
    </span>
  );
}

function getMetricDetail({
  emptyDetail,
  githubConnected,
  hasValue,
  index,
  onConnect,
}: {
  emptyDetail: string;
  githubConnected: boolean;
  hasValue: boolean;
  index: number;
  onConnect: () => void;
}): ReactNode {
  if (!githubConnected && index >= 2) {
    return <GitHubMetricPrompt onConnect={onConnect} />;
  }
  if (!hasValue) {
    return emptyDetail;
  }
  return "Updating as sessions are parsed";
}

const modelSeries = [
  { key: "claude", label: "Claude" },
  { key: "codex", label: "Codex" },
];

const prSeries = [{ key: "merged", label: "Merged PRs" }];

// Seven buckets per window, each hand-authored: the shape of spend and merged
// PRs differs per window rather than being one curve stretched by a factor.
const DAY_MS = 86_400_000;
const SERIES_END_DATE = "2026-08-25";

type SeriesSeed = { claude: number; codex: number; merged: number };

const RANGE_SERIES_SEEDS: Record<DashboardRange, readonly SeriesSeed[]> = {
  "7d": [
    { claude: 34, codex: 9, merged: 1 },
    { claude: 47, codex: 14, merged: 2 },
    { claude: 68, codex: 19, merged: 4 },
    { claude: 72, codex: 26, merged: 7 },
    { claude: 91, codex: 31, merged: 11 },
    { claude: 108, codex: 38, merged: 17 },
    { claude: 126, codex: 44, merged: 24 },
  ],
  "30d": [
    { claude: 148, codex: 52, merged: 6 },
    { claude: 202, codex: 71, merged: 15 },
    { claude: 264, codex: 88, merged: 27 },
    { claude: 311, codex: 104, merged: 39 },
    { claude: 358, codex: 122, merged: 51 },
    { claude: 402, codex: 141, merged: 64 },
    { claude: 455, codex: 158, merged: 78 },
  ],
  "90d": [
    { claude: 402, codex: 138, merged: 18 },
    { claude: 561, codex: 194, merged: 44 },
    { claude: 702, codex: 241, merged: 71 },
    { claude: 788, codex: 269, merged: 101 },
    { claude: 861, codex: 302, merged: 128 },
    { claude: 924, codex: 331, merged: 155 },
    { claude: 1052, codex: 385, merged: 181 },
  ],
  All: [
    { claude: 486, codex: 168, merged: 22 },
    { claude: 664, codex: 231, merged: 53 },
    { claude: 842, codex: 291, merged: 86 },
    { claude: 951, codex: 325, merged: 122 },
    { claude: 1038, codex: 361, merged: 155 },
    { claude: 1119, codex: 397, merged: 188 },
    { claude: 1380, codex: 507, merged: 219 },
  ],
};

const SERIES_BUCKETS = 7;

function bucketDate(bucketIndex: number, days: number) {
  const daysBack = Math.round(
    ((SERIES_BUCKETS - 1 - bucketIndex) * days) / SERIES_BUCKETS
  );
  return new Date(Date.parse(SERIES_END_DATE) - daysBack * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function visibleBuckets(progress: number, floor: number, span: number) {
  return Math.min(
    SERIES_BUCKETS,
    Math.max(1, Math.ceil(((progress - floor) / span) * SERIES_BUCKETS))
  );
}

function buildModelPoints(progress: number, range: DashboardRange) {
  if (progress < 28) {
    return [];
  }
  return RANGE_SERIES_SEEDS[range]
    .slice(0, visibleBuckets(progress, 28, 72))
    .map((seed, index) => ({
      date: bucketDate(index, RANGE_CONFIG[range].days),
      values: { claude: seed.claude, codex: seed.codex },
    }));
}

function buildPrPoints(progress: number, range: DashboardRange) {
  if (progress < 55) {
    return [];
  }
  return RANGE_SERIES_SEEDS[range]
    .slice(0, visibleBuckets(progress, 55, 45))
    .map((seed, index) => ({
      date: bucketDate(index, RANGE_CONFIG[range].days),
      values: { merged: seed.merged },
    }));
}

function ActivityPreview({
  progress,
  range,
}: {
  progress: number;
  range: DashboardRange;
}) {
  const filled = Math.round((activityCellIds.length * progress) / 100);
  const { busyStride, days } = RANGE_CONFIG[range];
  return (
    <div
      aria-label={`${progress}% of local activity imported over the last ${days} days`}
      className="grid min-h-52 grid-cols-[repeat(14,minmax(0,1fr))] content-center gap-2 py-8"
      role="img"
    >
      {activityCellIds.map((id, index) => (
        <span
          className={`aspect-square rounded-[3px] transition-colors duration-500 ${activityCellClass(
            index,
            filled,
            busyStride
          )}`}
          key={id}
        />
      ))}
    </div>
  );
}

const activityCellIds = Array.from(
  { length: 70 },
  (_, index) => `activity-cell-${index + 1}`
);

function activityCellClass(index: number, filled: number, busyStride: number) {
  if (index >= filled) {
    return "bg-muted";
  }
  return index % busyStride === 0 ? "bg-primary" : "bg-primary/55";
}

const recentSessionNames = [
  "Build onboarding progress state",
  "Review dashboard empty states",
  "Consolidate desktop and web shell",
  "Audit shared navigation components",
];

function RecentSessionsPreview({ count }: { count: number }) {
  return (
    <div className="divide-y rounded-lg border">
      {recentSessionNames.slice(0, count).map((name, index) => (
        <div
          className="fade-in slide-in-from-bottom-1 grid animate-in grid-cols-[1fr_auto_auto] items-center gap-5 px-4 py-3 text-sm"
          key={name}
        >
          <span className="font-medium">{name}</span>
          <span className="text-muted-foreground">
            {index % 2 === 0 ? "Claude" : "Codex"}
          </span>
          <span className="text-muted-foreground tabular-nums">
            {12 + index * 7}m
          </span>
        </div>
      ))}
    </div>
  );
}

function DashboardCard({
  title,
  description,
  children,
  fixedHeightClassName,
  tourTarget,
}: {
  title: string;
  description: string;
  children: ReactNode;
  fixedHeightClassName?: string;
  tourTarget?: DashboardTourTarget;
}) {
  return (
    <Card
      className="min-w-0 rounded-[1.25rem] border-border bg-card"
      data-dashboard-tour={tourTarget}
    >
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="min-w-0 font-semibold text-xl tracking-tight">
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent
        className={`min-w-0 px-4 sm:px-6 ${fixedHeightClassName ?? ""}`}
      >
        {children}
      </CardContent>
    </Card>
  );
}

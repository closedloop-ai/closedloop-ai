"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { CategoryBarChart } from "@repo/design-system/components/ui/category-bar-chart";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { ActivityHeatmap } from "@repo/design-system/components/ui/primitives/activity-heatmap";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { CompassIcon, LayersIcon, LockIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type {
  AiImpactMetric,
  PipelineNode,
  SessionRow,
  StatDatum,
} from "../app-mock";
import { currency } from "../app-mock";
import { type DashboardData, getDashboardData } from "../scope-data";
import { SessionsTable } from "./sessions-table";

// Progressive population: each row reveals once local parsing passes its
// threshold, so the dashboard fills in as the analysis runs.
const Reveal = ({
  show,
  skeletonClass,
  children,
}: {
  show: boolean;
  skeletonClass: string;
  children: ReactNode;
}) => (show ? children : <Skeleton className={skeletonClass} />);

const DashboardCard = ({
  title,
  description,
  anchor,
  heightClass,
  children,
}: {
  title: string;
  description?: string;
  anchor?: string;
  heightClass?: string;
  children: ReactNode;
}) => (
  <Card data-tour={anchor}>
    <CardHeader>
      <CardTitle className="text-base">{title}</CardTitle>
      {description ? <CardDescription>{description}</CardDescription> : null}
    </CardHeader>
    <CardContent>
      {heightClass ? <div className={heightClass}>{children}</div> : children}
    </CardContent>
  </Card>
);

const StatsRow = ({
  stats,
  countUpSessions,
  parsedCount,
}: {
  stats: readonly StatDatum[];
  /** While the Me-scope scan runs the Sessions total counts up with it. */
  countUpSessions: boolean;
  parsedCount: number;
}) => (
  <div
    className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-3 xl:grid-cols-5"
    data-tour="stats"
  >
    {stats.map((stat) => (
      <MetricCard
        delta={stat.delta}
        deltaLabel={stat.detail}
        deltaPolarity={stat.deltaPolarity}
        info={stat.info}
        key={stat.key}
        label={stat.label}
        unitLabel={stat.unitLabel}
        // The Sessions total counts up from the same progress snapshot as the
        // scan pill while parsing runs, instead of exposing the final total
        // mid-parse (r3706995125).
        value={
          stat.key === "sessions" && countUpSessions
            ? parsedCount.toLocaleString("en-US")
            : stat.value
        }
      />
    ))}
  </div>
);

const AiImpactRow = ({ metrics }: { metrics: readonly AiImpactMetric[] }) => (
  <DashboardCard
    description="How spend translates into shipped value"
    title="AI Impact"
  >
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {metrics.map((metric) => (
        <div className="space-y-1" key={metric.key}>
          <p className="font-semibold text-muted-foreground text-xs uppercase tracking-widest">
            {metric.label}
          </p>
          <p className="truncate font-semibold text-2xl tracking-tight">
            {metric.value}
          </p>
          <p className="text-muted-foreground text-sm">{metric.detail}</p>
        </div>
      ))}
    </div>
  </DashboardCard>
);

const RecentSessionsRow = ({
  sessions,
}: {
  sessions: readonly SessionRow[];
}) => (
  <DashboardCard description="Latest synced agent runs" title="Recent Sessions">
    <SessionsTable items={sessions} />
  </DashboardCard>
);

// Presentational agent-collaboration graph: a left-to-right role flow with the
// number of sessions that played each role, connected by thin rails.
const AgentPipelineRow = ({ nodes }: { nodes: readonly PipelineNode[] }) => (
  <DashboardCard
    anchor="agent-pipeline"
    description="How your agents hand work off to each other"
    title="Agent Collaboration Network"
  >
    <div className="flex items-center justify-between gap-2 py-4">
      {nodes.map((node, index) => (
        <div className="flex flex-1 items-center gap-2" key={node.id}>
          <div className="flex flex-1 flex-col items-center gap-1.5 text-center">
            <span className="flex size-12 items-center justify-center rounded-full border border-primary/25 bg-primary/10 font-semibold text-primary text-sm">
              {node.label.charAt(0)}
            </span>
            <span className="font-medium text-foreground text-sm">
              {node.label}
            </span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {node.sessions.toLocaleString("en-US")} sessions
            </span>
          </div>
          {index < nodes.length - 1 ? (
            <span className="h-px flex-1 bg-border" />
          ) : null}
        </div>
      ))}
    </div>
  </DashboardCard>
);

const RANGE_OPTIONS = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
] as const;

/**
 * The page title row: just the title and the primary actions (Tour, Sign Up),
 * so the numbers below aren't buried under a wrapping strip of chrome (PR #4368
 * review). The read-source pill, date range, and scope toggle live on their own
 * filter bar in DashboardFilterBar.
 */
const DashboardTitleRow = ({
  parsing,
  empty,
  signedUp,
  onTour,
  onSignUp,
}: {
  parsing: boolean;
  /** A scan that found nothing offers no tour: there is nothing to walk. */
  empty: boolean;
  signedUp: boolean;
  onTour: () => void;
  onSignUp: () => void;
}) => (
  <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
    <h1 className="font-semibold text-2xl tracking-tight">Dashboard</h1>
    <div className="flex items-center gap-2">
      {parsing || empty ? null : (
        <Button onClick={onTour} size="sm" variant="ghost">
          <CompassIcon />
          Tour
        </Button>
      )}
      {signedUp ? null : (
        <Button onClick={onSignUp} size="sm">
          Sign Up
        </Button>
      )}
    </div>
  </div>
);

/**
 * The dashboard's filter bar, sitting on the content rather than in the title:
 * the read-source pill (Local until an account exists, then Cloud), the
 * date-range filter, and the Me/Organization scope toggle. Organization stays
 * clickable for guests (its click prompts sign-up) and wears a lock so the gate
 * reads as expected, not as a control that silently refuses. The local-scan
 * status sits at the end while parsing runs.
 */
const DashboardFilterBar = ({
  parsing,
  parsedCount,
  signedUp,
  scope,
  onScopeChange,
}: {
  parsing: boolean;
  parsedCount: number;
  signedUp: boolean;
  scope: string;
  onScopeChange: (value: string) => void;
}) => {
  const [range, setRange] = useState("90d");

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Badge variant="outline">{signedUp ? "Cloud" : "Local"}</Badge>
        <ToggleGroup
          aria-label="Date range"
          onValueChange={(next) => {
            if (next) {
              setRange(next);
            }
          }}
          size="sm"
          type="single"
          value={range}
          variant="outline"
        >
          {RANGE_OPTIONS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex items-center gap-2">
          <span className="mr-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
            Scope
          </span>
          <ToggleGroup
            aria-label="Scope"
            onValueChange={(next) => {
              if (next) {
                onScopeChange(next);
              }
            }}
            size="sm"
            type="single"
            value={scope}
            variant="outline"
          >
            <ToggleGroupItem value="me">Me</ToggleGroupItem>
            {/* Org scope needs an account. It stays clickable for guests: the
                click prompts sign-up (via the flow reducer) while the effective
                scope stays Me. The lock makes that gate expected up front. */}
            <ToggleGroupItem value="org">
              Organization
              {signedUp ? null : (
                <LockIcon aria-hidden="true" className="size-3 opacity-70" />
              )}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      {parsing ? (
        <Badge variant="info">
          <span className="size-1.5 animate-pulse rounded-full bg-current" />
          Analyzing locally · {parsedCount.toLocaleString("en-US")} sessions
        </Badge>
      ) : null}
    </div>
  );
};

const DashboardBody = ({
  progress,
  parsing,
  parsedCount,
  scope,
  data,
}: {
  progress: number;
  parsing: boolean;
  parsedCount: number;
  scope: string;
  data: DashboardData;
}) => (
  <>
    <Reveal show={progress >= 12} skeletonClass="h-32 w-full rounded-xl">
      <StatsRow
        // Org totals are fixed team-wide numbers, so only the Me-scope scan
        // counts up; org scope shows its total straight away.
        countUpSessions={parsing && scope !== "org"}
        parsedCount={parsedCount}
        stats={data.stats}
      />
    </Reveal>

    <Reveal show={progress >= 22} skeletonClass="h-32 w-full rounded-xl">
      <AiImpactRow metrics={data.aiImpact} />
    </Reveal>

    <Reveal show={progress >= 38} skeletonClass="h-64 w-full rounded-xl">
      <DashboardCard
        anchor="activity"
        description="Each agent run and human input on this machine"
        title="Event Activity"
      >
        <ActivityHeatmap
          label="Event activity"
          weeks={[...data.heatmapWeeks]}
        />
      </DashboardCard>
    </Reveal>

    <Reveal show={progress >= 52} skeletonClass="h-72 w-full rounded-xl">
      <RecentSessionsRow sessions={data.recentSessions} />
    </Reveal>

    <Reveal show={progress >= 66} skeletonClass="h-96 w-full rounded-xl">
      <DashboardCard
        anchor="models"
        description="Model spend over time"
        heightClass="h-[340px]"
        title="Model Spend Over Time"
      >
        <TimeSeriesAreaChart
          points={[...data.modelUsagePoints]}
          series={[...data.modelUsageSeries]}
          valueFormatter={currency}
        />
      </DashboardCard>
    </Reveal>

    <Reveal show={progress >= 78} skeletonClass="h-64 w-full rounded-xl">
      <AgentPipelineRow nodes={data.pipelineNodes} />
    </Reveal>

    <Reveal show={progress >= 90} skeletonClass="h-80 w-full rounded-xl">
      <DashboardCard
        anchor="prs"
        description="PRs merged over time"
        heightClass="h-[320px]"
        title="PR throughput"
      >
        <TimeSeriesAreaChart
          points={[...data.prTrendPoints]}
          series={[...data.prTrendSeries]}
        />
      </DashboardCard>
    </Reveal>

    <Reveal show={progress >= 100} skeletonClass="h-80 w-full rounded-xl">
      <div
        className="grid grid-cols-1 gap-3 lg:grid-cols-2"
        data-tour="distribution"
      >
        <DashboardCard
          description="Total spend by model"
          heightClass="h-64"
          title="Spend by model"
        >
          <CategoryBarChart
            data={[...data.modelBreakdown]}
            horizontal
            showValueLabels
            valueFormatter={currency}
          />
        </DashboardCard>
        <DashboardCard
          description="Merged PRs by repository"
          heightClass="h-64"
          title="PRs by repo"
        >
          <CategoryBarChart
            data={[...data.prByRepo]}
            horizontal
            showValueLabels
          />
        </DashboardCard>
      </div>
    </Reveal>
  </>
);

export const DashboardView = ({
  progress,
  parsing,
  parsedCount,
  empty,
  signedUp,
  scope,
  onScopeChange,
  onTour,
  onSignUp,
}: {
  progress: number;
  parsing: boolean;
  parsedCount: number;
  /** A fresh machine with no agent history: the zero state (r3706838798). */
  empty: boolean;
  signedUp: boolean;
  scope: string;
  onScopeChange: (value: string) => void;
  onTour: () => void;
  onSignUp: () => void;
}) => {
  // Guests only ever see Me scope (the reducer gates org behind sign-up), so
  // this resolves to the org set only once an account exists and org is picked.
  const data = getDashboardData(scope);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-5">
      <DashboardTitleRow
        empty={empty}
        onSignUp={onSignUp}
        onTour={onTour}
        parsing={parsing}
        signedUp={signedUp}
      />

      {empty ? (
        <EmptyDashboard parsing={parsing} />
      ) : (
        <>
          <DashboardFilterBar
            onScopeChange={onScopeChange}
            parsedCount={parsedCount}
            parsing={parsing}
            scope={scope}
            signedUp={signedUp}
          />
          <DashboardBody
            data={data}
            parsedCount={parsedCount}
            parsing={parsing}
            progress={progress}
            scope={scope}
          />
        </>
      )}
    </div>
  );
};

// The zero state for a machine with no agent history (r3706838798): the scan
// runs, finds nothing, and the dashboard says so honestly instead of marching
// to 100% over seeded totals. Copy mirrors the production DashboardEmpty.
const EmptyDashboard = ({ parsing }: { parsing: boolean }) =>
  parsing ? (
    <Skeleton className="h-64 w-full rounded-xl" />
  ) : (
    <EmptyState
      className="min-h-[360px] rounded-xl border border-border/70 bg-card"
      description="Start using Claude Code, Codex, or another agent on this Mac and your sessions will appear here automatically. Computed locally, nothing uploaded."
      icon={LayersIcon}
      title="No agent sessions yet"
    />
  );

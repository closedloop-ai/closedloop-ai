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
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { Separator } from "@repo/design-system/components/ui/separator";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { CableIcon, GithubIcon, UserIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import {
  aiImpactMetrics,
  type DashboardScope,
  meMetricsByRange,
  orgAiImpactMetrics,
  orgMetricsByRange,
  orgSessions,
  type RangeKey,
  recentSessions,
} from "../mock";
import { ActivityCard } from "./activity-card";
import { TourInsights } from "./tour-insights";

type DashboardProps = {
  githubConnected: boolean;
  onConnectGitHub: () => void;
  workspaceName: string;
  showDemoData: boolean;
  onShowDemoData: () => void;
  onHideDemoData: () => void;
};

export const Dashboard = ({
  githubConnected,
  onConnectGitHub,
  workspaceName,
  showDemoData,
  onShowDemoData,
  onHideDemoData,
}: DashboardProps) => {
  const [range, setRange] = useState<RangeKey>("90d");
  const [scope, setScope] = useState<DashboardScope>("me");

  // A brand-new workspace has nothing yet — show the first-run empty state and
  // let the reviewer toggle the populated demo on, rather than presenting
  // weeks of data a forty-second-old workspace could not have.
  if (!showDemoData) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-5">
        <h1 className="font-semibold text-2xl tracking-tight">Dashboard</h1>
        <Card>
          <EmptyState
            action={
              <Button onClick={onShowDemoData} variant="outline">
                Preview with demo data
              </Button>
            }
            description="Once your workspace has agent sessions, your spend, models, and delivery metrics show up here."
            icon={CableIcon}
            title="No data yet"
          />
        </Card>
      </div>
    );
  }

  const activeMetrics =
    scope === "org"
      ? (orgMetricsByRange[range] ?? orgMetricsByRange["90d"])
      : (meMetricsByRange[range] ?? meMetricsByRange["90d"]);

  const activeSessions = (scope === "org" ? orgSessions : recentSessions).slice(
    0,
    sessionSliceFor(range)
  );

  const activeAiImpact = scope === "org" ? orgAiImpactMetrics : aiImpactMetrics;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h1 className="font-semibold text-2xl tracking-tight">Dashboard</h1>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Badge variant="outline">
            {scope === "org" ? (
              <>
                <UsersIcon />
                Organization
              </>
            ) : (
              <>
                <UserIcon />
                Your activity
              </>
            )}
          </Badge>
          <ToggleGroup
            aria-label="Date range"
            onValueChange={(value) => {
              if (value) {
                setRange(value as RangeKey);
              }
            }}
            size="sm"
            type="single"
            value={range}
            variant="outline"
          >
            {rangeOptions.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="flex items-center gap-2">
            <span className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
              Scope
            </span>
            <ToggleGroup
              aria-label="Scope"
              onValueChange={(value) => {
                if (value) {
                  setScope(value as DashboardScope);
                }
              }}
              size="sm"
              type="single"
              value={scope}
              variant="outline"
            >
              <ToggleGroupItem value="me">Me</ToggleGroupItem>
              <ToggleGroupItem value="org">Organization</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <Button onClick={onHideDemoData} size="sm" variant="outline">
            Clear demo data
          </Button>
        </div>
      </div>

      <div
        className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-3 xl:grid-cols-5"
        data-tour="stats"
      >
        {activeMetrics.map((metric) =>
          metric.requiresGitHub && !githubConnected ? (
            <MetricCard
              detail={
                <Button
                  className="h-auto p-0 text-xs"
                  onClick={onConnectGitHub}
                  size="sm"
                  variant="link"
                >
                  <GithubIcon className="size-3" />
                  Connect GitHub
                </Button>
              }
              key={metric.label}
              label={metric.label}
              value={null}
              valueUnavailableLabel="—"
            />
          ) : (
            <MetricCard
              delta={metric.delta}
              deltaLabel="vs. prior period"
              deltaPolarity={metric.deltaPolarity}
              key={metric.label}
              label={metric.label}
              value={metric.value}
            />
          )
        )}
      </div>

      <AiImpactCard
        aiImpact={activeAiImpact}
        githubConnected={githubConnected}
        onConnectGitHub={onConnectGitHub}
      />

      <TourInsights range={range} scope={scope} />

      <div>
        <p className="text-muted-foreground text-sm">{workspaceName}</p>
        <h2 className="font-semibold text-lg tracking-tight">
          {scope === "org"
            ? "Latest sessions across your team"
            : "Your latest sessions"}
        </h2>
      </div>

      <ActivityCard rows={activeSessions} valueLabel="Efficiency" />
    </div>
  );
};

const AiImpactCard = ({
  aiImpact,
  githubConnected,
  onConnectGitHub,
}: {
  aiImpact: typeof aiImpactMetrics;
  githubConnected: boolean;
  onConnectGitHub: () => void;
}) => (
  <Card>
    <CardHeader>
      <CardTitle>AI Impact</CardTitle>
      <CardDescription>
        How estimated cost translates into shipped value
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {aiImpact.map((metric) => {
          const unavailable = metric.requiresGitHub && !githubConnected;
          return (
            <div className="space-y-1" key={metric.key}>
              <p className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                {metric.label}
              </p>
              <p
                className="truncate font-semibold text-2xl tracking-tight"
                title={unavailable ? "—" : metric.value}
              >
                {unavailable ? "—" : metric.value}
              </p>
              <p className="text-muted-foreground text-sm">
                {unavailable ? "Requires GitHub" : metric.detail}
              </p>
            </div>
          );
        })}
      </div>
      {githubConnected ? null : (
        <>
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <p className="text-muted-foreground text-sm">
              Connect GitHub to unlock cost per merged PR, tokens per KLOC, and
              top repo.
            </p>
            <Button onClick={onConnectGitHub} size="sm" variant="outline">
              <GithubIcon />
              Connect GitHub
            </Button>
          </div>
        </>
      )}
    </CardContent>
  </Card>
);

const sessionSliceFor = (range: RangeKey) => {
  if (range === "7d") {
    return 2;
  }
  if (range === "30d") {
    return 3;
  }
  return 4;
};

const rangeOptions = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
] as const;

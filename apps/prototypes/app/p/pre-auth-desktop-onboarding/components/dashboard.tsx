"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { cn } from "@repo/design-system/lib/utils";
import { CableIcon, GithubIcon } from "lucide-react";
import { useState } from "react";
import {
  aiImpactMetrics,
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
  desktopConnected: boolean;
  githubConnected: boolean;
  onConnectGitHub: () => void;
  onInstallDesktop: () => void;
  onSignUp: () => void;
  onTour: () => void;
  signedIn: boolean;
  workspaceName: string;
};

export const Dashboard = ({
  desktopConnected,
  githubConnected,
  onConnectGitHub,
  onInstallDesktop,
  onSignUp,
  onTour,
  signedIn,
  workspaceName,
}: DashboardProps) => {
  const [range, setRange] = useState<RangeKey>("90d");
  const [scope, setScope] = useState<"me" | "org">("me");

  const activeMetrics =
    scope === "org"
      ? (orgMetricsByRange[range] ?? orgMetricsByRange["90d"])
      : (meMetricsByRange[range] ?? meMetricsByRange["90d"]);

  let sessionSlice = 4;
  if (range === "7d") {
    sessionSlice = 2;
  } else if (range === "30d") {
    sessionSlice = 3;
  }
  const activeSessions = (scope === "org" ? orgSessions : recentSessions).slice(
    0,
    sessionSlice
  );

  const activeAiImpact = scope === "org" ? orgAiImpactMetrics : aiImpactMetrics;

  const isOrgGated = scope === "org" && !signedIn;

  if (!desktopConnected) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6 md:p-10">
        <h1 className="font-semibold text-2xl tracking-tight">Dashboard</h1>
        <Card>
          <EmptyState
            action={
              <Button onClick={onInstallDesktop}>
                Install Closedloop Desktop
              </Button>
            }
            description="Install Desktop to analyze the agent sessions already on this machine."
            icon={CableIcon}
            title="Bring in your agent sessions"
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-5">
      {/* Header — always interactive so the user can toggle scope/range even
          when the org gate overlay is showing. */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h1 className="font-semibold text-2xl tracking-tight">Dashboard</h1>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
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
                  setScope(value as "me" | "org");
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
          <Button onClick={onTour} size="sm" variant="outline">
            Tour
          </Button>
        </div>
      </div>

      {/* Gated content — dimmed + overlaid when org scope is selected
          pre-auth. The outer wrapper stays non-interactive so clicks on the
          dim area don't interfere; the CTA card re-enables pointer events. */}
      <div className="relative">
        <div
          aria-hidden={isOrgGated}
          className={cn(
            "flex flex-col gap-5",
            isOrgGated && "pointer-events-none select-none opacity-30"
          )}
        >
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

          <TourInsights />

          <div>
            <p className="text-muted-foreground text-sm">{workspaceName}</p>
            <h2 className="font-semibold text-lg tracking-tight">
              {scope === "org"
                ? "Latest sessions"
                : "Latest sessions on this Mac"}
            </h2>
          </div>

          <ActivityCard rows={activeSessions} valueLabel="Efficiency" />
        </div>

        {/* Org sign-up gate — floats over the dimmed content above */}
        {isOrgGated ? (
          <div className="pointer-events-none absolute inset-0 flex items-start justify-center px-6 pt-24">
            <Card className="pointer-events-auto w-full max-w-sm shadow-2xl">
              <CardHeader>
                <CardTitle>See {workspaceName}</CardTitle>
                <CardDescription>
                  Create a free account to compare AI spend and output across
                  your team.
                </CardDescription>
              </CardHeader>
              <CardFooter>
                <Button className="w-full" onClick={onSignUp}>
                  Create account
                </Button>
              </CardFooter>
            </Card>
          </div>
        ) : null}
      </div>
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
  // Plain section, not a titled Card: the tiles are themselves MetricCards, so
  // wrapping them in another bordered card would double the chrome. The heading
  // matches the "Latest sessions" block below, and the tiles sit on the page
  // background exactly like the top metrics row.
  <section aria-labelledby="ai-impact-heading" className="flex flex-col gap-3">
    <div>
      <h2
        className="font-semibold text-lg tracking-tight"
        id="ai-impact-heading"
      >
        AI Impact
      </h2>
      <p className="text-muted-foreground text-sm">
        How estimated cost translates into shipped value
      </p>
    </div>
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {aiImpact.map((metric) => {
        const unavailable = metric.requiresGitHub && !githubConnected;
        return (
          <MetricCard
            detail={unavailable ? "Requires GitHub" : metric.detail}
            key={metric.key}
            label={metric.label}
            value={unavailable ? null : metric.value}
          />
        );
      })}
    </div>
    {githubConnected ? null : (
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3">
        <p className="text-muted-foreground text-sm">
          Connect GitHub to unlock cost per merged PR, tokens per KLOC, and top
          repo.
        </p>
        <Button onClick={onConnectGitHub} size="sm" variant="outline">
          <GithubIcon />
          Connect GitHub
        </Button>
      </div>
    )}
  </section>
);

const rangeOptions = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
] as const;

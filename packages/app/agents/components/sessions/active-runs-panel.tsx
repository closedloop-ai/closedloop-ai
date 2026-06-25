"use client";

import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import type { Tone } from "@repo/design-system/components/ui/types";
import { ActivityIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  formatDuration,
  formatTokenCount,
} from "../../../shared/lib/format-utils";
import {
  ACTIVE_RUN_PHASE_KIND,
  type ActiveRunPhaseKind,
  type ActiveRunView,
  deriveActiveRuns,
} from "../../lib/active-runs";

/** How often the panel re-evaluates stall state and elapsed timers. */
const TICK_INTERVAL_MS = 10_000;

const PHASE_TONE: Record<ActiveRunPhaseKind, Tone> = {
  [ACTIVE_RUN_PHASE_KIND.Working]: "success",
  [ACTIVE_RUN_PHASE_KIND.AwaitingInput]: "accent",
  [ACTIVE_RUN_PHASE_KIND.Stalled]: "warning",
};

export type ActiveRunsPanelProps = {
  items: AgentSessionListItem[];
  isLoading: boolean;
  getSessionHref: (item: ActiveRunView) => string;
};

/**
 * Live "what's running now" panel for the Sessions surface (emergent
 * Feature). Complements the retrospective Session History table and
 * Monitoring analytics by showing currently-running sessions with their current
 * phase (SPEC §7.2), live token burn (§4.1.6), and a stall indicator (§5.3.6).
 *
 * Presentation-only: callers pass the active (`status === "active"`) rows from
 * the session sync stream; the panel derives the view model on a ticking clock
 * so stalls surface and elapsed timers advance without new data.
 */
export function ActiveRunsPanel({
  items,
  isLoading,
  getSessionHref,
}: ActiveRunsPanelProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const runs = deriveActiveRuns(items, nowMs);
  const stalledCount = runs.filter((run) => run.isStalled).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ActivityIcon className="h-4 w-4" />
              Active runs
            </CardTitle>
            <CardDescription>
              Sessions running right now — current phase, live token burn, and
              stall detection.
            </CardDescription>
          </div>
          {runs.length > 0 ? (
            <div className="flex items-center gap-2">
              {stalledCount > 0 ? (
                <ToneBadge
                  label={`${stalledCount} stalled`}
                  pulse
                  tone="warning"
                />
              ) : null}
              <ToneBadge label={`${runs.length} running`} tone="success" />
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <ActiveRunsBody
          getSessionHref={getSessionHref}
          isLoading={isLoading}
          nowMs={nowMs}
          runs={runs}
        />
      </CardContent>
    </Card>
  );
}

function ActiveRunsBody({
  isLoading,
  runs,
  nowMs,
  getSessionHref,
}: {
  isLoading: boolean;
  runs: ActiveRunView[];
  nowMs: number;
  getSessionHref: (item: ActiveRunView) => string;
}) {
  if (isLoading) {
    return <Skeleton className="h-[120px] w-full" />;
  }

  if (runs.length === 0) {
    return (
      <EmptyState
        className="py-8"
        description="No sessions are running right now. Active runs appear here while agents are working."
        icon={ActivityIcon}
        title="Nothing running"
      />
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {runs.map((run) => (
        <ActiveRunRow
          getSessionHref={getSessionHref}
          key={run.id}
          nowMs={nowMs}
          run={run}
        />
      ))}
    </ul>
  );
}

function ActiveRunRow({
  run,
  nowMs,
  getSessionHref,
}: {
  run: ActiveRunView;
  nowMs: number;
  getSessionHref: (item: ActiveRunView) => string;
}) {
  const pulse = !run.isStalled;
  return (
    <li className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 items-center gap-2">
        <a
          className="truncate font-medium text-sm hover:underline"
          href={getSessionHref(run)}
        >
          {run.name}
        </a>
        <ToneBadge
          className="shrink-0"
          label={run.phaseLabel}
          pulse={pulse}
          tone={PHASE_TONE[run.phaseKind]}
        />
      </div>
      <div className="flex shrink-0 items-center gap-3 text-muted-foreground text-xs">
        <span className="uppercase tracking-wide">{run.harness}</span>
        <span title="Live token burn">
          {formatTokenCount(run.tokenBurn)} tokens
        </span>
        <span title="Elapsed">
          {formatDuration(run.startedAt, new Date(nowMs))}
        </span>
      </div>
    </li>
  );
}

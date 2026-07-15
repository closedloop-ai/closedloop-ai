/**
 * Desktop optimization-analytics panel (FEA-2923 / AC-022 / §E).
 *
 * The consumer for the three personal-optimization analytics IPC methods that
 * were implemented on the main side but previously had no renderer surface:
 *
 *   - `getComponentModelTrend(kind, key, model?, days?)` — per-model
 *     token/cost/latency/compaction time series for the selected component.
 *   - `getSubagentFrequency(subagentKey, days?)` — sub-agent pull-in frequency.
 *   - `isSkillLoaded(skillKey)` — skill-loaded triage (exists vs. actually used).
 *
 * The panel derives the analytics "component key" from the selected component's
 * name (the local desktop `agent_components` key column is the component name
 * for these kinds), and calls the kind-appropriate IPC:
 *   - subagent → frequency chart + model trend
 *   - skill    → skill-loaded badge + model trend
 *   - other    → model trend only
 */

import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import type {
  ComponentModelTrendResponse,
  SkillLoadedResponse,
  SubagentFrequencyResponse,
} from "@repo/api/src/types/agent-component";
import { useEffect, useState } from "react";

/** Trailing window used for all trend/frequency queries. */
const TREND_DAYS = 30;

export type OptimizationTarget = {
  /** Component kind (e.g. "subagent", "skill", "command"). */
  kind: string;
  /** Analytics key — the desktop `agent_components.key`, i.e. the name. */
  key: string;
  /** Display name for headings. */
  name: string;
};

type Phase = "loading" | "ready" | "error";

export function OptimizationAnalyticsPanel({
  target,
}: {
  target: OptimizationTarget;
}) {
  return (
    <div
      className="flex flex-col gap-6 p-4"
      data-testid="optimization-analytics-panel"
    >
      <h2 className="font-semibold text-sm">Optimization · {target.name}</h2>
      {target.kind === "skill" ? <SkillLoadedCard target={target} /> : null}
      {target.kind === "subagent" ? (
        <SubagentFrequencyCard target={target} />
      ) : null}
      <ModelTrendCard target={target} />
    </div>
  );
}

function ModelTrendCard({ target }: { target: OptimizationTarget }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [data, setData] = useState<ComponentModelTrendResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    window.desktopApi?.db
      ?.getComponentModelTrend(target.kind, target.key, undefined, TREND_DAYS)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setPhase("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPhase("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [target.kind, target.key]);

  if (phase === "loading") {
    return <Skeleton className="h-24 w-full" data-testid="trend-loading" />;
  }
  if (phase === "error" || !data) {
    return (
      <p className="text-muted-foreground text-sm" data-testid="trend-error">
        Could not load token trend.
      </p>
    );
  }
  return (
    <section data-testid="model-trend-card">
      <h3 className="mb-2 font-medium text-xs">
        Token trend ({data.windowDays}d)
      </h3>
      {data.points.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="trend-empty">
          No usage recorded in this window.
        </p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="text-left">Day</th>
              <th className="text-left">Model</th>
              <th className="text-right">In</th>
              <th className="text-right">Out</th>
              <th className="text-right">Cost</th>
            </tr>
          </thead>
          <tbody data-testid="trend-rows">
            {data.points.map((p) => (
              <tr key={`${p.day}:${p.model}`}>
                <td>{p.day}</td>
                <td className="truncate">{p.model}</td>
                <td className="text-right">{p.inputTokens}</td>
                <td className="text-right">{p.outputTokens}</td>
                <td className="text-right">
                  {p.estimatedCostUsd === null
                    ? "—"
                    : `$${p.estimatedCostUsd.toFixed(2)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function SubagentFrequencyCard({ target }: { target: OptimizationTarget }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [data, setData] = useState<SubagentFrequencyResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    window.desktopApi?.db
      ?.getSubagentFrequency(target.key, TREND_DAYS)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setPhase("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPhase("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [target.key]);

  if (phase === "loading") {
    return <Skeleton className="h-16 w-full" data-testid="frequency-loading" />;
  }
  if (phase === "error" || !data) {
    return (
      <p
        className="text-muted-foreground text-sm"
        data-testid="frequency-error"
      >
        Could not load pull-in frequency.
      </p>
    );
  }
  const totalSessions = data.points.reduce((sum, p) => sum + p.sessionCount, 0);
  return (
    <section data-testid="subagent-frequency-card">
      <h3 className="mb-1 font-medium text-xs">Pull-in frequency</h3>
      <p className="text-muted-foreground text-sm">
        Invoked across {totalSessions} session
        {totalSessions === 1 ? "" : "s"} in the last {data.windowDays} days.
      </p>
    </section>
  );
}

function SkillLoadedCard({ target }: { target: OptimizationTarget }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [data, setData] = useState<SkillLoadedResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    window.desktopApi?.db
      ?.isSkillLoaded(target.key)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setPhase("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPhase("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [target.key]);

  if (phase === "loading") {
    return <Skeleton className="h-8 w-40" data-testid="skill-loaded-loading" />;
  }
  if (phase === "error" || !data) {
    return null;
  }
  const loaded = data.existsInInventory && data.hasUsage;
  return (
    <section data-testid="skill-loaded-card">
      <Badge variant={loaded ? "success" : "warning"}>
        {loaded ? "Skill loading" : "Not loading"}
      </Badge>
      <span className="ml-2 text-muted-foreground text-xs">
        {data.totalInvocations} invocation
        {data.totalInvocations === 1 ? "" : "s"}
      </span>
    </section>
  );
}

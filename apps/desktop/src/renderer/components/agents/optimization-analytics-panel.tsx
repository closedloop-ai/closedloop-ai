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
  /**
   * ISS-4403: the FULL content hash the detail page's usage lanes were scoped to
   * (`AgentComponentDetail.analyticsFingerprint` — the resolver's
   * `effectiveFingerprint`, NOT `versionId` and NOT the short display badge).
   * When present, the three optimization reads are content-scoped to exactly
   * this version so two same-name/different-content components render their own
   * distinct analytics on their distinct content-hash detail pages (FEA-4335),
   * consistent with the rest of the page. Omitted for a legacy name-level route
   * (or a hash-less component), which falls back to name-level analytics exactly
   * as before.
   */
  fingerprint?: string;
  /**
   * ISS-4403: the short (8-hex) display badge for the resolved version, shown in
   * the panel subhead so the reader knows WHICH version the numbers describe.
   * Present exactly when {@link fingerprint} is (a content-scoped read); omitted
   * on a name-level route, where the panel is honestly name-wide.
   */
  shortFingerprint?: string;
};

/**
 * Whether the panel is scoped to one exact content version (a content-hash
 * route) vs. aggregating the whole name (a legacy name-level route). Drives the
 * version-honest heading, badge, and empty-state copy.
 */
function isVersionScoped(target: OptimizationTarget): boolean {
  return Boolean(target.fingerprint);
}

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
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-sm">Optimization · {target.name}</h2>
        {/*
         * ISS-4403: the panel is version-scoped on a content-hash route, so the
         * heading must say WHICH version these numbers describe — otherwise two
         * detail pages for the same component name render different numbers under
         * an identical title. On a name-level route it is honestly name-wide.
         * Also disambiguates from the Prompt panel's revision dropdown above: this
         * scope is the routed version, not a control the reader picks here.
         */}
        <p className="text-muted-foreground text-xs">
          {target.shortFingerprint
            ? `This version · #${target.shortFingerprint}`
            : "All versions of this component"}
        </p>
      </div>
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
    // ISS-4403: preserve the legacy call ARITY when there is no fingerprint —
    // an older preload forwards a trailing explicit `undefined` as an extra IPC
    // argument instead of omitting it. Append the content-scope arg ONLY for a
    // content-scoped read.
    const db = window.desktopApi?.db;
    const trend = target.fingerprint
      ? db?.getComponentModelTrend(
          target.kind,
          target.key,
          undefined,
          TREND_DAYS,
          target.fingerprint
        )
      : db?.getComponentModelTrend(
          target.kind,
          target.key,
          undefined,
          TREND_DAYS
        );
    trend
      ?.then((res) => {
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
  }, [target.kind, target.key, target.fingerprint]);

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
          {/*
           * ISS-4403: carry the scope. On a version-scoped page "No usage
           * recorded" reads as "this component was never used" — a different,
           * misleading fact from "this version wasn't used". This is a neutral
           * empty state, not an error, so the copy stays plain muted text.
           */}
          {isVersionScoped(target)
            ? `No usage for this version in the last ${data.windowDays} days.`
            : `No usage recorded in the last ${data.windowDays} days.`}
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
    // ISS-4403: legacy arity when unscoped (see ModelTrendCard).
    const db = window.desktopApi?.db;
    const frequency = target.fingerprint
      ? db?.getSubagentFrequency(target.key, TREND_DAYS, target.fingerprint)
      : db?.getSubagentFrequency(target.key, TREND_DAYS);
    frequency
      ?.then((res) => {
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
  }, [target.key, target.fingerprint]);

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
        {/*
         * ISS-4403: name the scope so a version-scoped zero doesn't read as "this
         * sub-agent was never pulled in" when it just wasn't for this version.
         */}
        {isVersionScoped(target)
          ? `This version invoked across ${totalSessions} session${totalSessions === 1 ? "" : "s"} in the last ${data.windowDays} days.`
          : `Invoked across ${totalSessions} session${totalSessions === 1 ? "" : "s"} in the last ${data.windowDays} days.`}
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
    // ISS-4403: legacy arity when unscoped (see ModelTrendCard).
    const db = window.desktopApi?.db;
    const skillLoaded = target.fingerprint
      ? db?.isSkillLoaded(target.key, target.fingerprint)
      : db?.isSkillLoaded(target.key);
    skillLoaded
      ?.then((res) => {
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
  }, [target.key, target.fingerprint]);

  if (phase === "loading") {
    return <Skeleton className="h-8 w-40" data-testid="skill-loaded-loading" />;
  }
  if (phase === "error" || !data) {
    return null;
  }
  const skillBadge = resolveSkillBadge(data, isVersionScoped(target));
  return (
    <section data-testid="skill-loaded-card">
      <Badge variant={skillBadge.variant}>{skillBadge.label}</Badge>
      <span className="ml-2 text-muted-foreground text-xs">
        {data.totalInvocations} invocation
        {data.totalInvocations === 1 ? "" : "s"}
      </span>
    </section>
  );
}

/**
 * ISS-4403: honest skill-loaded badge.
 *
 * The `warning` variant is an ALARM ("this skill is installed but the harness
 * isn't actually loading it") and is only truthful at NAME level, where zero
 * usage across every version really does mean the skill isn't being pulled in.
 * On a content-hash route the read is scoped to one exact version, so "no usage
 * for this content hash" is an expected, neutral fact — not an alarm — for any
 * version that simply isn't the one in use. Rendering warning-yellow there would
 * make a perfectly-loading skill look broken. So a version-scoped no-usage state
 * uses the neutral `secondary` variant with scope-honest copy.
 */
function resolveSkillBadge(
  data: SkillLoadedResponse,
  versionScoped: boolean
): { variant: "success" | "warning" | "secondary"; label: string } {
  const loaded = data.existsInInventory && data.hasUsage;
  if (loaded) {
    return { variant: "success", label: "Skill loading" };
  }
  if (versionScoped) {
    return { variant: "secondary", label: "No usage for this version" };
  }
  return { variant: "warning", label: "Not loading" };
}

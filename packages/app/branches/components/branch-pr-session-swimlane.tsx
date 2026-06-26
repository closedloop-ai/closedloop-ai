"use client";

import type {
  BranchPageDetail,
  MergedTraceItem,
} from "@repo/api/src/types/branch";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { RotateCwIcon, ShieldCheckIcon, SparklesIcon } from "lucide-react";
import { useMemo } from "react";
import {
  type BranchActorColorDomain,
  buildActorColorDomain,
  deriveActorsFromSessions,
} from "../lib/branch-actor-domain";
import { type BurstSpan, computeBurstSpans } from "../lib/branch-burst-spans";
import {
  fractionOf,
  type TimeRange,
  timeRange,
} from "../lib/branch-timeline-range";

/**
 * Actor Gantt swimlane (Epic E / E4) — the design handoff's `BQLanes`. One lane
 * per linked session (ordered by start), tinted with the shared E0 actor color so
 * lanes match the E1 timeline. Active bursts (the complement of idle spans within
 * each session window, via `branch-burst-spans`) render as solid segments along
 * the shared axis; inter-burst idle is IMPLICIT (no idle/gap elements — V2). CI
 * and resumed badges read the contract's `sessionstart.actor` flags directly
 * (`ci` / `isResumed`), falling back to `harness === "ci"` and idle→active
 * transitions. An optional `activeTimestamp` draws a playhead line across lanes;
 * clicking a burst scrubs the trace via `onScrubTimestamp`.
 *
 * Positioning uses the shared page `range` (the E1 timeline span) when provided,
 * so the playhead and bursts line up horizontally with the timeline, playhead
 * scrubber, and event-dot rail above. Without it, the lanes fall back to a
 * standalone axis derived from their own session/burst extents.
 */
export type BranchPrSessionSwimlaneProps = {
  detail: BranchPageDetail;
  /** Inject the parent's shared domain so lane colors match E1; else derived. */
  actorDomain?: BranchActorColorDomain;
  /** Shared axis (from E1) so lanes align with the bars; else derived internally. */
  range?: TimeRange | null;
  activeTimestamp?: string | null;
  onScrubTimestamp?: (t: string) => void;
  isLoading?: boolean;
  className?: string;
};

type SwimlaneLane = {
  sessionId: string;
  label: string;
  sub: string;
  color: string;
  isCi: boolean;
  isResumed: boolean;
  bursts: BurstSpan[];
  activeMs: number;
};

function burstMs(span: BurstSpan): number {
  return Math.max(0, Date.parse(span.endT) - Date.parse(span.startT));
}

/** A session's actor: its captured `sessionstart` name, else harness, else null. */
function resolveLaneActor(
  capturedName: string | null,
  harness: string
): string | null {
  if (capturedName != null && capturedName !== "") {
    return capturedName;
  }
  return harness === "" ? null : harness;
}

function buildLanes(
  detail: BranchPageDetail,
  domain: BranchActorColorDomain
): { lanes: SwimlaneLane[]; axis: TimeRange | null } {
  const startActorBySession = new Map<
    string,
    { name: string | null; ci: boolean; isResumed: boolean }
  >();
  const itemsBySession = new Map<string, MergedTraceItem[]>();
  for (const item of detail.mergedTrace) {
    const list = itemsBySession.get(item.sessionId) ?? [];
    list.push(item);
    itemsBySession.set(item.sessionId, list);
    if (item.type === "sessionstart") {
      startActorBySession.set(item.sessionId, {
        name: item.actor.name,
        ci: item.actor.ci === true,
        isResumed: item.actor.isResumed === true,
      });
    }
  }

  const sessions = [...detail.sessions].sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)
  );
  const lanes = sessions.map((session): SwimlaneLane => {
    const meta = startActorBySession.get(session.sessionId);
    const actor = resolveLaneActor(meta?.name ?? null, session.harness);
    const bursts = computeBurstSpans({
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      items: itemsBySession.get(session.sessionId) ?? [],
    });
    return {
      sessionId: session.sessionId,
      label: domain.labelFor(actor),
      sub: session.name ?? session.slug ?? session.harness,
      color: domain.colorFor(actor),
      isCi: session.harness === "ci" || meta?.ci === true,
      isResumed:
        meta?.isResumed === true || bursts.some((burst) => burst.isResumption),
      bursts,
      activeMs: bursts.reduce((sum, burst) => sum + burstMs(burst), 0),
    };
  });

  const starts: string[] = [];
  const ends: (string | null)[] = [];
  for (const session of sessions) {
    starts.push(session.startedAt);
    ends.push(session.endedAt);
  }
  for (const lane of lanes) {
    for (const burst of lane.bursts) {
      starts.push(burst.startT);
      ends.push(burst.endT);
    }
  }
  return { lanes, axis: timeRange(starts, ends) };
}

export function BranchPrSessionSwimlane({
  detail,
  actorDomain,
  range,
  activeTimestamp,
  onScrubTimestamp,
  isLoading = false,
  className,
}: BranchPrSessionSwimlaneProps) {
  const domain = useMemo(
    () =>
      actorDomain ?? buildActorColorDomain(deriveActorsFromSessions(detail)),
    [actorDomain, detail]
  );
  const { lanes, axis: internalAxis } = useMemo(
    () => buildLanes(detail, domain),
    [detail, domain]
  );
  // Prefer the shared page range so lanes align with the E1 timeline/playhead;
  // fall back to the standalone session/burst extent when it isn't supplied.
  const axis = range ?? internalAxis;

  if (isLoading) {
    return <Skeleton className={cn("h-[120px] w-full", className)} />;
  }

  if (lanes.length === 0) {
    return (
      <EmptyState
        className={className}
        description="No sessions linked to this branch."
        icon={SparklesIcon}
        title="No sessions"
      />
    );
  }

  const activeMs = activeTimestamp ? Date.parse(activeTimestamp) : null;
  const playheadPercent =
    axis && activeMs != null && !Number.isNaN(activeMs)
      ? fractionOf(axis, activeMs) * 100
      : null;

  return (
    <section className={cn("bq-lanes", className)}>
      {lanes.map((lane) => (
        <SwimlaneRow
          axis={axis}
          key={lane.sessionId}
          lane={lane}
          onScrubTimestamp={onScrubTimestamp}
          playheadPercent={playheadPercent}
        />
      ))}
    </section>
  );
}

function SwimlaneRow({
  lane,
  axis,
  playheadPercent,
  onScrubTimestamp,
}: {
  lane: SwimlaneLane;
  axis: TimeRange | null;
  playheadPercent: number | null;
  onScrubTimestamp?: (t: string) => void;
}) {
  const first = lane.bursts[0];
  const last = lane.bursts.at(-1);
  const extent =
    axis && first && last
      ? {
          left: fractionOf(axis, Date.parse(first.startT)) * 100,
          right: fractionOf(axis, Date.parse(last.endT)) * 100,
        }
      : null;

  return (
    <div className="bq-lane">
      <div className="bq-lane-id">
        <span
          className="bq-aico"
          style={{ color: lane.color, borderColor: lane.color }}
        >
          {lane.isCi ? (
            <ShieldCheckIcon size={11} />
          ) : (
            <SparklesIcon size={11} />
          )}
        </span>
        <span className="bq-lane-name">{lane.label}</span>
        {lane.sub ? <span className="bq-lane-sub">{lane.sub}</span> : null}
        {lane.isCi ? <span className="bq-lane-tag">CI</span> : null}
        {lane.isResumed ? (
          <span className="bq-lane-resumed">
            <RotateCwIcon size={8} />
            resumed
          </span>
        ) : null}
      </div>
      <div className="bq-lane-track">
        {extent ? (
          <span
            className="bq-lane-extent"
            style={{
              left: `${extent.left}%`,
              width: `${Math.max(0.5, extent.right - extent.left)}%`,
            }}
          />
        ) : null}
        {axis
          ? lane.bursts.map((burst) => {
              const left = fractionOf(axis, Date.parse(burst.startT)) * 100;
              const right = fractionOf(axis, Date.parse(burst.endT)) * 100;
              return (
                <button
                  aria-label={`${lane.label} active burst`}
                  className="bq-lane-seg"
                  key={burst.startT}
                  onClick={() => onScrubTimestamp?.(burst.startT)}
                  style={{
                    left: `${left}%`,
                    width: `${Math.max(0.6, right - left)}%`,
                    background: lane.color,
                  }}
                  title={`Active · ${formatDurationMs(burstMs(burst))}`}
                  type="button"
                />
              );
            })
          : null}
        {playheadPercent == null ? null : (
          <span
            className="bq-lane-playhead"
            style={{ left: `${playheadPercent}%` }}
          />
        )}
      </div>
      <div className="bq-lane-meta">
        <span className="font-mono">{formatDurationMs(lane.activeMs)}</span>
      </div>
    </div>
  );
}

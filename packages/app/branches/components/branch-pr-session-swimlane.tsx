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
import { memo, useMemo } from "react";
import {
  type BranchActorColorDomain,
  buildActorColorDomain,
  deriveActorsFromSessions,
} from "../lib/branch-actor-domain";
import { computeBurstSpans } from "../lib/branch-burst-spans";
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

/**
 * A burst with its ISO endpoints pre-parsed to epoch ms once (in the memoized
 * `buildLanes`), so the per-scrub render path positions segments with plain
 * arithmetic instead of re-`Date.parse`-ing every burst on every playhead move
 * (PLN-1148 Phase 4).
 */
type LaneBurst = {
  startT: string;
  endT: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  isResumption: boolean;
};

type SwimlaneLane = {
  sessionId: string;
  label: string;
  sub: string;
  color: string;
  isCi: boolean;
  isResumed: boolean;
  bursts: LaneBurst[];
  activeMs: number;
};

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
    const bursts: LaneBurst[] = computeBurstSpans({
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      items: itemsBySession.get(session.sessionId) ?? [],
    }).map((burst) => {
      const startMs = Date.parse(burst.startT);
      const endMs = Date.parse(burst.endT);
      return {
        startT: burst.startT,
        endT: burst.endT,
        startMs,
        endMs,
        durationMs: Math.max(0, endMs - startMs),
        isResumption: burst.isResumption,
      };
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
      activeMs: bursts.reduce((sum, burst) => sum + burst.durationMs, 0),
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

export const BranchPrSessionSwimlane = memo(function BranchPrSessionSwimlane({
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
});

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
  // The lane's static content (its extent band + active-burst buttons) depends
  // only on the lane and the shared axis — never on the playhead. Memoize it so
  // a scrub, which changes only `playheadPercent`, reuses these elements and
  // React updates just the playhead line instead of rebuilding every burst
  // button on every pointer move (PLN-1148 Phase 4). Positions read the burst's
  // pre-parsed ms, so there's no `Date.parse` on this path.
  const track = useMemo(() => {
    const first = lane.bursts[0];
    const last = lane.bursts.at(-1);
    const extent =
      axis && first && last
        ? {
            left: fractionOf(axis, first.startMs) * 100,
            right: fractionOf(axis, last.endMs) * 100,
          }
        : null;
    return (
      <>
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
              const left = fractionOf(axis, burst.startMs) * 100;
              const right = fractionOf(axis, burst.endMs) * 100;
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
                  title={`Active · ${formatDurationMs(burst.durationMs)}`}
                  type="button"
                />
              );
            })
          : null}
      </>
    );
  }, [lane, axis, onScrubTimestamp]);

  return (
    <div className="bq-lane">
      <div className="bq-lane-id">
        <span
          className="bq-aico"
          style={{ color: lane.color, borderColor: lane.color }}
        >
          {lane.isCi ? (
            <ShieldCheckIcon aria-hidden size={11} />
          ) : (
            <SparklesIcon aria-hidden size={11} />
          )}
        </span>
        <span className="bq-lane-name">{lane.label}</span>
        {lane.sub ? <span className="bq-lane-sub">{lane.sub}</span> : null}
        {lane.isCi ? <span className="bq-lane-tag">CI</span> : null}
        {lane.isResumed ? (
          <span className="bq-lane-resumed">
            <RotateCwIcon aria-hidden size={8} />
            resumed
          </span>
        ) : null}
      </div>
      <div className="bq-lane-track">
        {track}
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

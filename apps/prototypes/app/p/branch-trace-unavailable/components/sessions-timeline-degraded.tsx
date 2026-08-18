"use client";

// The Sessions & timeline tab of the branches prototype, extended with the
// ISS-5555 degraded trace-read states. Layout, sticky header, bars, and trace
// are the flow owner's (`app/p/branches` sessions-timeline); the additions are:
//
//  1. An honest session-count label derived from the TRACE read, not the detail
//     read — "N sessions" only when every session's events rendered, otherwise
//     "M of N sessions rendered" (production already computes exactly this
//     string in branch-sessions-timeline-tab.tsx; on a failed read it yields
//     "0 of N sessions rendered" — today nothing downstream tells the user why).
//  2. A full-failure disclosure (reason-mapped EmptyState, retry only when
//     retry can help) replacing the empty timeline + trace.
//  3. A partial-failure warning (Alert) naming the session whose events could
//     not load, above the trace built from the sessions that did.
//  4. The unfixed render, reachable from the scenario switcher for contrast.

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { chartColorPairForTokenIndex } from "@repo/design-system/components/ui/chart-colors";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BranchDetail, SessionLane } from "@/app/p/branches/mock";
import {
  SESSION_UNAVAILABLE_NOTE,
  TraceReadOutcome,
  type TraceUnavailableReason,
} from "../mock";
import { CombinedTrace, traceActorEntries } from "./combined-trace";
import { type TimelineActorEntry, TimelineBars } from "./timeline-bars";
import { TraceUnavailableDisclosure } from "./trace-unavailable-disclosure";

export type DegradedSessionsTimelineProps = {
  /** The detail to render — already reconciled per scenario (see mock.ts). */
  detail: BranchDetail;
  outcome: TraceReadOutcome;
  reason: TraceUnavailableReason;
  /** Session count from the DETAIL read — the header's total population. */
  totalSessionCount: number;
  /** The session whose events failed to hydrate (Incomplete outcome only). */
  unavailableSession: SessionLane | null;
  retrying: boolean;
  onRetry: () => void;
};

export function DegradedSessionsTimeline({
  detail,
  outcome,
  reason,
  totalSessionCount,
  unavailableSession,
  retrying,
  onRetry,
}: DegradedSessionsTimelineProps) {
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const clearActiveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (clearActiveTimer.current) {
        clearTimeout(clearActiveTimer.current);
      }
    },
    []
  );

  const jumpToTurn = (turnId: string) => {
    const target = document.getElementById(`branch-trace-turn-${turnId}`);
    const scrollContainer = target?.closest<HTMLElement>('[role="tabpanel"]');
    if (target && scrollContainer) {
      const targetRect = target.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      const centeredTop =
        scrollContainer.scrollTop +
        targetRect.top -
        containerRect.top -
        (scrollContainer.clientHeight - targetRect.height) / 2;
      scrollContainer.scrollTo({
        behavior: "smooth",
        top: Math.max(0, centeredTop),
      });
    }
    setActiveTurnId(turnId);
    if (clearActiveTimer.current) {
      clearTimeout(clearActiveTimer.current);
    }
    clearActiveTimer.current = setTimeout(() => setActiveTurnId(null), 1400);
  };

  const actorEntries = resolveActorEntries(detail, outcome);
  const showBars = outcome !== TraceReadOutcome.Unavailable;

  return (
    <>
      <div className="sticky top-0 z-10 border-b bg-background">
        <div className="mx-auto w-full max-w-content px-5 py-4">
          <section>
            <div className="mb-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="font-semibold text-foreground text-sm">
                PR timeline
                {retrying ? (
                  // While the retry is in flight the count is UNKNOWN — a
                  // pending read must not assert "0 of 4 rendered" (that is
                  // the resolved claim, and conflating the two is the exact
                  // confusion ISS-5555 exists to remove).
                  <Skeleton className="ml-2 inline-block h-3 w-28 align-middle" />
                ) : (
                  <span className="ml-1 font-normal text-[11px] normal-case tracking-normal opacity-80">
                    · {sessionCountLabel(detail, outcome, totalSessionCount)}
                  </span>
                )}
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                {actorEntries.map((entry) => (
                  <span
                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                    key={entry.name}
                  >
                    <span
                      className="size-2 rounded-[2px]"
                      style={{ background: entry.color }}
                    />
                    {entry.name}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-3 text-muted-foreground text-xs">
                <span>
                  <b className="text-foreground">{detail.costLabel}</b> cost
                </span>
                <span>
                  <b className="text-foreground">{detail.valuePerDollar}</b>{" "}
                  LOC/$
                </span>
                <span className="font-semibold text-foreground">
                  {detail.wallClockLabel}
                </span>
              </div>
            </div>
            {showBars ? (
              <TimelineBars
                actorEntries={actorEntries}
                detail={detail}
                onJumpToTurn={jumpToTurn}
              />
            ) : null}
          </section>
        </div>
      </div>
      <div className="mx-auto w-full max-w-content px-5 pt-6 pb-10">
        {retrying ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <TimelineTabBody
            activeTurnId={activeTurnId}
            detail={detail}
            onRetry={onRetry}
            outcome={outcome}
            reason={reason}
            totalSessionCount={totalSessionCount}
            unavailableSession={unavailableSession}
          />
        )}
      </div>
    </>
  );
}

function TimelineTabBody({
  activeTurnId,
  detail,
  onRetry,
  outcome,
  reason,
  totalSessionCount,
  unavailableSession,
}: {
  activeTurnId: string | null;
  detail: BranchDetail;
  onRetry: () => void;
  outcome: TraceReadOutcome;
  reason: TraceUnavailableReason;
  totalSessionCount: number;
  unavailableSession: SessionLane | null;
}) {
  if (outcome === TraceReadOutcome.Unavailable) {
    return (
      <TraceUnavailableDisclosure
        onRetry={onRetry}
        reason={reason}
        sessionCount={totalSessionCount}
      />
    );
  }
  if (outcome === TraceReadOutcome.Incomplete) {
    return (
      <div className="flex flex-col gap-5">
        {unavailableSession ? (
          <SessionUnavailableAlert
            onRetry={onRetry}
            reason={reason}
            renderedCount={detail.sessions.length}
            session={unavailableSession}
            totalCount={totalSessionCount}
          />
        ) : null}
        <CombinedTrace activeTurnId={activeTurnId} detail={detail} />
      </div>
    );
  }
  // Loaded — and the unfixed BugEmpty render, whose "Combined session trace"
  // heading over zero turns is exactly what production paints today.
  return <CombinedTrace activeTurnId={activeTurnId} detail={detail} />;
}

/**
 * The partial-failure disclosure (fix state 3): both counts up front — how many
 * sessions loaded properly and how many failed — then the failed session named
 * with the sanitized reason, and a retry. Warning tone, not destructive — a gap
 * in evidence, not a failed run.
 */
function SessionUnavailableAlert({
  onRetry,
  reason,
  renderedCount,
  session,
  totalCount,
}: {
  onRetry: () => void;
  reason: TraceUnavailableReason;
  renderedCount: number;
  session: SessionLane;
  totalCount: number;
}) {
  const failedCount = Math.max(0, totalCount - renderedCount);
  return (
    <Alert variant="warning">
      <TriangleAlertIcon aria-hidden />
      <AlertTitle>
        {failedCount} session{failedCount === 1 ? "" : "s"} failed to render
      </AlertTitle>
      <AlertDescription>
        <p>
          {session.sub} ({session.actor}) — {SESSION_UNAVAILABLE_NOTE[reason]}.
          The timeline and trace below cover only the {renderedCount} session
          {renderedCount === 1 ? "" : "s"} that rendered.
        </p>
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          <RefreshCwIcon aria-hidden />
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Header legend. Normally derived from the trace's human turns (the flow
 * owner's behavior). In the unfixed bug state the trace is empty but the DETAIL
 * read still names every session's actor — production draws its named-but-empty
 * lanes from exactly that — so the legend falls back to the detail-side
 * timeline legend to reproduce the lie faithfully. In the Unavailable fix state
 * the legend is dropped: nothing below renders, so naming actors would claim
 * evidence the tab does not hold.
 */
function resolveActorEntries(
  detail: BranchDetail,
  outcome: TraceReadOutcome
): TimelineActorEntry[] {
  if (outcome === TraceReadOutcome.Unavailable) {
    return [];
  }
  const fromTrace = traceActorEntries(detail);
  if (fromTrace.length > 0) {
    return fromTrace;
  }
  const seen = new Set<string>();
  const entries: TimelineActorEntry[] = [];
  for (const legendEntry of detail.timeline.legend) {
    if (!seen.has(legendEntry.actorId)) {
      seen.add(legendEntry.actorId);
      entries.push({
        color: chartColorPairForTokenIndex(seen.size === 1 ? 0 : 4).base,
        id: legendEntry.actorId,
        name: legendEntry.name,
      });
    }
  }
  return entries;
}

/**
 * The honest count label — the same derivation production already ships
 * (`sessionLabel` in branch-sessions-timeline-tab.tsx): claim "N sessions" only
 * when the rendered population matches the branch's, otherwise say exactly how
 * many rendered. The unfixed bug state deliberately bypasses this and reads the
 * DETAIL count, reproducing today's lying header.
 */
function sessionCountLabel(
  detail: BranchDetail,
  outcome: TraceReadOutcome,
  totalSessionCount: number
): string {
  if (
    outcome === TraceReadOutcome.Loaded ||
    outcome === TraceReadOutcome.BugEmpty
  ) {
    return `${totalSessionCount} session${totalSessionCount === 1 ? "" : "s"}`;
  }
  const renderedCount =
    outcome === TraceReadOutcome.Unavailable ? 0 : detail.sessions.length;
  return `${renderedCount} of ${totalSessionCount} sessions rendered`;
}

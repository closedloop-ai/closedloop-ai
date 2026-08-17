"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactSessionTrace, GenericArtifact } from "../mock";
import { ArtifactKind } from "../mock";
import {
  formatDuration,
  type SessionRow,
  sessionRows,
} from "./experimental/session/mock";
import {
  buildSessionDetail,
  type SessionDetail,
} from "./experimental/session/mock-detail";
import {
  SessionTimeline,
  type SessionTimelineGrouping,
  type TimelineJumpBehavior,
} from "./experimental/session/session-timeline";
import {
  SessionTrace,
  type TraceCommentAnchor,
} from "./experimental/session/session-trace";
import {
  interpolateMinutesAtY,
  interpolateYAtMinutes,
  nearestAnchorAtY,
  nextScrollFollowY,
  type TracePositionAnchor,
} from "./trace-scroll-model";

const WHITESPACE_PATTERN = /\s+/;
const HOURS_PATTERN = /(\d+(?:\.\d+)?)h/;
const MINUTES_PATTERN = /(\d+(?:\.\d+)?)m/;
const WALL_CLOCK_PATTERN = /(\d{1,2}):(\d{2})\s*(am|pm)/i;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SIMULATED_WALL_CLOCK_MINUTES = 13 * 24 * 60;
const TRACE_VIEWPORT_GAP = 12;

export function ArtifactSessionsTrace({
  artifact,
  commentAnchors,
  defaultGrouping = "actor",
  detailOverride,
  onSubmitTraceComment,
  trace,
  traceJumpRequest,
}: {
  artifact: GenericArtifact;
  commentAnchors: TraceCommentAnchor[];
  defaultGrouping?: SessionTimelineGrouping;
  detailOverride?: SessionDetail;
  onSubmitTraceComment: (comment: {
    anchorPreview: string;
    body: string;
    traceRow: number;
  }) => void;
  trace: ArtifactSessionTrace;
  traceJumpRequest: {
    commentId?: string;
    nonce: number;
    row: number;
  } | null;
}) {
  const generatedDetail = useMemo<SessionDetail | null>(() => {
    const isSingleSession = trace.sessions.length === 1;
    // Repeat the representative writing sessions to make the aggregate trace
    // long enough to exercise the fixed 24-column window and scrubber without
    // changing the canonical Session Details components. A Session artifact is
    // already the atomic unit, so it must never be repeated into a false
    // multi-day aggregate.
    const simulatedSessions = isSingleSession
      ? trace.sessions
      : trace.sessions.flatMap((writingSession) =>
          Array.from({ length: 4 }, (_, pass) => ({
            ...writingSession,
            id: `${writingSession.id}-pass-${pass + 1}`,
            title:
              pass === 0
                ? writingSession.title
                : `${writingSession.title} · iteration ${pass + 1}`,
          }))
        );
    const rows = simulatedSessions.map((writingSession, index) => {
      const source =
        sessionRows.find((row) => row.id === artifact.id) ??
        (sessionRows[index % sessionRows.length] as SessionRow);
      return {
        ...source,
        id: writingSession.id,
        name: writingSession.title,
        cost: writingSession.phases.reduce((sum, phase) => sum + phase.cost, 0),
        // Give each simulated iteration enough room for its steering, work,
        // verification, and commit markers to occupy distinct timeline
        // buckets instead of producing an artificial two-dot stack in every
        // bucket at broader scales.
        durationMs:
          parseDuration(writingSession.duration) * (isSingleSession ? 1 : 3),
        model: writingSession.model,
        user: {
          id: writingSession.id,
          name: writingSession.contributor,
          initials: initials(writingSession.contributor),
        },
      };
    });
    const details = rows.map(buildSessionDetail);
    const first = details[0];
    if (!first) {
      return null;
    }
    const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
    const activeMinutes = details.reduce(
      (sum, sessionDetail) => sum + sessionDetail.durationMinutes,
      0
    );
    const wallClockMinutes = Math.max(
      parseDuration(trace.wallClock) / 60_000,
      isSingleSession ? activeMinutes : activeMinutes * 1.35,
      isSingleSession ? 1 : SIMULATED_WALL_CLOCK_MINUTES
    );
    const interSessionGap =
      details.length > 1
        ? Math.max(0, wallClockMinutes - activeMinutes) / (details.length - 1)
        : 0;
    let elapsedOffset = 0;
    let rowOffset = 0;
    const costEvents: SessionDetail["costEvents"] = [];
    const timelineMarkers: SessionDetail["timelineMarkers"] = [];
    const combinedTrace: SessionDetail["trace"] = [];
    for (const [detailIndex, sessionDetail] of details.entries()) {
      const writingSession = simulatedSessions[detailIndex];
      const actorName = writingSession?.contributor ?? sessionDetail.ownerName;
      const actorInitials =
        writingSession?.contributorInitials ?? initials(actorName);
      // The trace is the canonical clock for the aggregate fixture. Every
      // chart sample and marker resolves through its referenced transcript row
      // so a bar/dot jump, the scrubber, and the visible message always land
      // on the same elapsed instant.
      const traceMinutesByRow = new Map(
        sessionDetail.trace.map((turn, index) => [
          turn.row ?? index,
          parseElapsed(turn.timeLabel),
        ])
      );
      costEvents.push(
        ...sessionDetail.costEvents.map((event) => ({
          ...event,
          actorId: actorName,
          actorInitials,
          actorName,
          atMinutes:
            elapsedOffset +
            (traceMinutesByRow.get(event.traceRow) ?? event.atMinutes),
          traceRow: event.traceRow + rowOffset,
        }))
      );
      timelineMarkers.push(
        ...sessionDetail.timelineMarkers.map((marker) => ({
          ...marker,
          atMinutes:
            elapsedOffset +
            (traceMinutesByRow.get(marker.traceRow) ?? marker.atMinutes),
          traceRow: marker.traceRow + rowOffset,
        }))
      );
      combinedTrace.push(
        ...sessionDetail.trace.map((turn, index) => {
          const row = rowOffset + (turn.row ?? index);
          const atMinutes = elapsedOffset + parseElapsed(turn.timeLabel);
          const nextTurn = sessionDetail.trace[index + 1];
          const turnEndMinutes = nextTurn
            ? parseElapsed(nextTurn.timeLabel)
            : sessionDetail.durationMinutes;
          const derivedDuration = formatDuration(
            Math.max(
              1000,
              (turnEndMinutes - parseElapsed(turn.timeLabel)) * 60_000
            )
          );
          return {
            ...turn,
            actorId: actorName,
            actorInitials,
            actorName,
            durationLabel:
              turn.side === "agent"
                ? (turn.durationLabel ?? derivedDuration)
                : undefined,
            id: `${sessionDetail.id}-${turn.id}`,
            row,
            sentLabel: formatWallClockAt(
              trace.startDate,
              trace.startAt,
              atMinutes
            ),
            timeLabel: formatElapsed(atMinutes),
          };
        })
      );
      elapsedOffset += sessionDetail.durationMinutes;
      rowOffset += sessionDetail.trace.length;
      if (detailIndex < details.length - 1) {
        combinedTrace.push({
          blocks: [
            {
              spans: ["Idle between contributing sessions"],
              type: "p",
            },
          ],
          durationLabel: formatDurationLabel(interSessionGap),
          id: `${sessionDetail.id}-idle-after`,
          kind: "idle",
          row: rowOffset,
          sentLabel: formatWallClockAt(
            trace.startDate,
            trace.startAt,
            elapsedOffset
          ),
          side: "agent",
          timeLabel: formatElapsed(elapsedOffset),
        });
        elapsedOffset += interSessionGap;
        rowOffset += 1;
      }
    }
    const canonicalTrace = combinedTrace.map((turn, index) =>
      index === combinedTrace.length - 1
        ? {
            ...turn,
            sentLabel: formatWallClockAt(
              trace.startDate,
              trace.startAt,
              wallClockMinutes
            ),
            timeLabel: formatElapsed(wallClockMinutes),
          }
        : turn
    );
    const canonicalMinutesByRow = new Map(
      canonicalTrace.map((turn, index) => [
        turn.row ?? index,
        parseElapsed(turn.timeLabel),
      ])
    );
    return {
      ...first,
      name: `${artifact.slug} writing sessions`,
      ownerName: "Multiple contributors",
      model: `${new Set(rows.map((row) => row.model)).size} models`,
      durationLabel: formatDurationLabel(wallClockMinutes),
      durationMinutes: wallClockMinutes,
      timelineStartDate: trace.startDate,
      timelineStartMinutes:
        parseWallClockMinutes(trace.startAt) ?? first.timelineStartMinutes,
      costLabel: `$${totalCost.toFixed(2)}`,
      tokensLabel: `${(totalCost * 168_000).toLocaleString("en-US")} tokens`,
      timelineStartLabel: trace.startAt,
      timelineEndLabel: trace.endAt,
      costEvents: costEvents.map((event) => ({
        ...event,
        atMinutes: canonicalMinutesByRow.get(event.traceRow) ?? event.atMinutes,
      })),
      timelineMarkers: timelineMarkers.map((marker) => ({
        ...marker,
        atMinutes:
          canonicalMinutesByRow.get(marker.traceRow) ?? marker.atMinutes,
      })),
      trace: canonicalTrace,
      turnCount: details.reduce((sum, item) => sum + item.turnCount, 0),
      toolCount: details.reduce((sum, item) => sum + item.toolCount, 0),
    };
  }, [artifact.id, artifact.slug, trace]);
  const detail = detailOverride ?? generatedDetail;

  if (!detail) {
    return null;
  }
  return (
    <SynchronizedArtifactTrace
      artifact={artifact}
      commentAnchors={commentAnchors}
      defaultGrouping={defaultGrouping}
      detail={detail}
      onSubmitTraceComment={onSubmitTraceComment}
      traceJumpRequest={traceJumpRequest}
    />
  );
}

function SynchronizedArtifactTrace({
  artifact,
  commentAnchors,
  defaultGrouping,
  detail,
  onSubmitTraceComment,
  traceJumpRequest,
}: {
  artifact: GenericArtifact;
  commentAnchors: TraceCommentAnchor[];
  defaultGrouping: SessionTimelineGrouping;
  detail: SessionDetail;
  onSubmitTraceComment: (comment: {
    anchorPreview: string;
    body: string;
    traceRow: number;
  }) => void;
  traceJumpRequest: {
    commentId?: string;
    nonce: number;
    row: number;
  } | null;
}) {
  const [activeTraceRow, setActiveTraceRow] = useState(0);
  const [activeMinutes, setActiveMinutes] = useState(0);
  const [traceTailPadding, setTraceTailPadding] = useState(40);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const traceAnchorsRef = useRef<TracePositionAnchor[]>([]);
  const scrollFrameRef = useRef<number | null>(null);
  const scrubFollowFrameRef = useRef<number | null>(null);
  const scrubFollowTargetRef = useRef<number | null>(null);
  const scrubFollowLastTimeRef = useRef<number | null>(null);
  const scrollDriverRef = useRef<"scrubber" | "trace">("trace");

  const synchronizeFromScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    const anchors = traceAnchorsRef.current;
    if (!(scroller && anchors.length > 0)) {
      return;
    }
    const viewportY = scroller.scrollTop + TRACE_VIEWPORT_GAP;
    const minutes = interpolateMinutesAtY(anchors, viewportY);
    const row = nearestAnchorAtY(anchors, viewportY).row;
    setActiveMinutes(minutes);
    setActiveTraceRow((current) => (current === row ? current : row));
  }, []);

  const measureTraceAnchors = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const traceMinutes = new Map(
      detail.trace.map((turn, index) => [
        turn.row ?? index,
        parseElapsed(turn.timeLabel),
      ])
    );
    traceAnchorsRef.current = [
      ...scroller.querySelectorAll<HTMLElement>("[data-trace-row]"),
    ].flatMap((node) => {
      const row = Number(node.dataset.traceRow);
      const minutes = traceMinutes.get(row);
      return minutes == null
        ? []
        : [
            {
              minutes,
              row,
              y:
                node.getBoundingClientRect().top -
                scrollerRect.top +
                scroller.scrollTop,
            },
          ];
    });
    const lastTraceRow = scroller.querySelector<HTMLElement>(
      "[data-trace-row]:last-child"
    );
    const requiredTailPadding = Math.max(
      40,
      Math.ceil(
        scroller.clientHeight -
          TRACE_VIEWPORT_GAP -
          (lastTraceRow?.offsetHeight ?? 0)
      )
    );
    setTraceTailPadding((current) =>
      current === requiredTailPadding ? current : requiredTailPadding
    );
    synchronizeFromScroll();
  }, [detail.trace, synchronizeFromScroll]);

  const handleTraceScroll = useCallback(() => {
    if (
      scrollDriverRef.current === "scrubber" ||
      scrollFrameRef.current != null
    ) {
      return;
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (scrollDriverRef.current === "trace") {
        synchronizeFromScroll();
      }
    });
  }, [synchronizeFromScroll]);

  const cancelScrubberFollow = useCallback(
    (synchronize = true) => {
      if (scrubFollowFrameRef.current != null) {
        cancelAnimationFrame(scrubFollowFrameRef.current);
      }
      scrubFollowFrameRef.current = null;
      scrubFollowTargetRef.current = null;
      scrubFollowLastTimeRef.current = null;
      scrollDriverRef.current = "trace";
      if (synchronize) {
        synchronizeFromScroll();
      }
    },
    [synchronizeFromScroll]
  );

  const followScrubberTarget = useCallback(
    (targetTop: number) => {
      const scroller = scrollerRef.current;
      if (!scroller) {
        return;
      }
      scrubFollowTargetRef.current = targetTop;
      scrollDriverRef.current = "scrubber";
      if (scrubFollowFrameRef.current != null) {
        return;
      }
      scrubFollowLastTimeRef.current = performance.now();
      const advance = (now: number) => {
        const activeScroller = scrollerRef.current;
        const target = scrubFollowTargetRef.current;
        if (!(activeScroller && target != null)) {
          cancelScrubberFollow(false);
          return;
        }
        const elapsed = Math.max(
          1,
          now - (scrubFollowLastTimeRef.current ?? now)
        );
        scrubFollowLastTimeRef.current = now;
        const nextTop = nextScrollFollowY(
          activeScroller.scrollTop,
          target,
          elapsed,
          Math.max(2400, activeScroller.clientHeight * 8)
        );
        activeScroller.scrollTop = nextTop;
        if (nextTop === target) {
          scrubFollowFrameRef.current = null;
          scrubFollowTargetRef.current = null;
          scrubFollowLastTimeRef.current = null;
          scrollDriverRef.current = "trace";
          synchronizeFromScroll();
          return;
        }
        scrubFollowFrameRef.current = requestAnimationFrame(advance);
      };
      scrubFollowFrameRef.current = requestAnimationFrame(advance);
    },
    [cancelScrubberFollow, synchronizeFromScroll]
  );

  const setActiveTracePosition = useCallback(
    (
      row: number,
      atMinutes?: number,
      behavior: TimelineJumpBehavior = "smooth"
    ) => {
      const turn = detail.trace.find(
        (candidate, index) => (candidate.row ?? index) === row
      );
      const minutes = Math.max(
        0,
        Math.min(
          detail.durationMinutes,
          atMinutes ?? (turn ? parseElapsed(turn.timeLabel) : 0)
        )
      );
      const scroller = scrollerRef.current;
      if (!scroller) {
        setActiveMinutes(minutes);
        setActiveTraceRow(row);
        return;
      }
      const anchors = traceAnchorsRef.current;
      const target = scroller.querySelector<HTMLElement>(
        `#session-trace-row-${row}`
      );
      let targetY: number | null = null;
      if (anchors.length > 0) {
        targetY = interpolateYAtMinutes(anchors, minutes);
      } else if (target) {
        targetY =
          target.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop;
      }
      if (targetY == null) {
        return;
      }
      if (behavior === "instant") {
        setActiveMinutes(minutes);
        setActiveTraceRow(row);
      }
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;
      const targetTop = Math.max(
        0,
        Math.min(
          scroller.scrollHeight - scroller.clientHeight,
          targetY - TRACE_VIEWPORT_GAP
        )
      );
      if (behavior === "instant" && !reducedMotion) {
        followScrubberTarget(targetTop);
        return;
      }
      cancelScrubberFollow(false);
      scroller.scrollTo({
        behavior: reducedMotion ? "auto" : "smooth",
        top: targetTop,
      });
    },
    [
      cancelScrubberFollow,
      detail.durationMinutes,
      detail.trace,
      followScrubberTarget,
    ]
  );

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }
    const frame = requestAnimationFrame(measureTraceAnchors);
    const observer = new ResizeObserver(measureTraceAnchors);
    const trace = scroller.querySelector<HTMLElement>("[data-session-trace]");
    observer.observe(scroller);
    if (trace) {
      observer.observe(trace);
    }
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (scrollFrameRef.current != null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
      if (scrubFollowFrameRef.current != null) {
        cancelAnimationFrame(scrubFollowFrameRef.current);
      }
    };
  }, [measureTraceAnchors]);

  useEffect(() => {
    if (!traceJumpRequest) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      measureTraceAnchors();
      setActiveTracePosition(traceJumpRequest.row);
    });
    return () => cancelAnimationFrame(frame);
  }, [measureTraceAnchors, setActiveTracePosition, traceJumpRequest]);
  return (
    <div
      aria-label={`${artifact.slug} writing sessions`}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      role="tabpanel"
    >
      <div className="z-10 shrink-0 border-b bg-background">
        <div className="mx-auto w-full max-w-[1000px] px-5 py-5">
          <SessionTimeline
            activeMinutes={activeMinutes}
            defaultGrouping={defaultGrouping}
            detail={detail}
            onJump={setActiveTracePosition}
            title={
              artifact.kind === ArtifactKind.Agent
                ? "Definition Contribution Costs Over Time"
                : undefined
            }
          />
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-auto"
        data-session-detail-scroll
        onScroll={handleTraceScroll}
        onWheel={() => cancelScrubberFollow()}
        ref={scrollerRef}
      >
        <div
          className="mx-auto w-full max-w-[1000px] px-5 pt-6"
          style={{ paddingBottom: traceTailPadding }}
        >
          <SessionTrace
            activeCommentAnchorId={traceJumpRequest?.commentId}
            activeCommentAnchorNonce={traceJumpRequest?.nonce}
            activeTraceRow={activeTraceRow}
            commentAnchors={commentAnchors}
            detail={detail}
            observeActiveTraceRow={false}
            onActiveTraceRowChange={setActiveTraceRow}
            onSubmitTraceComment={onSubmitTraceComment}
          />
        </div>
      </div>
    </div>
  );
}

function parseElapsed(label: string): number {
  const [hours, minutes] = label.split(":");
  return Number(hours ?? 0) * 60 + Number(minutes ?? 0);
}

function formatElapsed(minutes: number): string {
  const roundedMinutes = Math.round(minutes);
  return `${Math.floor(roundedMinutes / 60)}:${String(roundedMinutes % 60).padStart(2, "0")}`;
}

function parseDuration(duration: string): number {
  const hours = Number(duration.match(HOURS_PATTERN)?.[1] ?? 0);
  const minutes = Number(duration.match(MINUTES_PATTERN)?.[1] ?? 0);
  return (hours * 60 + minutes) * 60 * 1000;
}

function formatDurationLabel(minutes: number): string {
  if (minutes >= 24 * 60) {
    const days = Math.floor(minutes / (24 * 60));
    const hours = Math.round((minutes % (24 * 60)) / 60);
    return `${days}d ${hours}h`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return `${hours}h ${remainder}m`;
}

function formatWallClockAt(
  startDate: string,
  startLabel: string,
  elapsedMinutes: number
): string {
  const clockMatch = startLabel.match(WALL_CLOCK_PATTERN);
  const dateMatch = startDate.match(ISO_DATE_PATTERN);
  if (!(clockMatch && dateMatch)) {
    return formatElapsed(elapsedMinutes);
  }
  const startHour = Number(clockMatch[1]) % 12;
  const startMinute = Number(clockMatch[2]);
  const periodOffset = clockMatch[3]?.toLowerCase() === "pm" ? 12 * 60 : 0;
  const absoluteMinutes =
    startHour * 60 +
    startMinute +
    periodOffset +
    Math.max(0, Math.round(elapsedMinutes));
  const dayOffset = Math.floor(absoluteMinutes / (24 * 60));
  const wrappedMinutes = absoluteMinutes % (24 * 60);
  const hour24 = Math.floor(wrappedMinutes / 60);
  const minute = wrappedMinutes % 60;
  const period = hour24 < 12 ? "AM" : "PM";
  const hour12 = hour24 % 12 || 12;
  const clock = `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
  const date = new Date(
    Date.UTC(
      Number(dateMatch[1]),
      Number(dateMatch[2]) - 1,
      Number(dateMatch[3]) + dayOffset
    )
  );
  const dateLabel = `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
  return `${dateLabel} ${clock}`;
}

function parseWallClockMinutes(label: string): number | null {
  const match = label.match(WALL_CLOCK_PATTERN);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]) % 12;
  const minute = Number(match[2]);
  const periodOffset = match[3]?.toLowerCase() === "pm" ? 12 * 60 : 0;
  return hour * 60 + minute + periodOffset;
}

function initials(name: string): string {
  return name
    .split(WHITESPACE_PATTERN)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

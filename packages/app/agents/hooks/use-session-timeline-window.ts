"use client";

import { resolveSessionTimelineAxisEnd } from "@repo/app/agents/lib/session-duration";
import {
  resolveSessionTimelineWindow,
  type SessionTimelineWindow,
  type SessionTimelineWindowSource,
} from "@repo/app/agents/lib/session-timeline-geometry";
import { useMemo } from "react";

/**
 * Everything the Session Timeline needs to agree with itself: the window its
 * bucket/marker/dot geometry is plotted over, and the two instants its axis
 * labels name. ONE object from ONE derivation, so the label and the geometry can
 * never be derived from two different windows again (ISS-4833 / ISS-4821).
 */
export type SessionTimelineWindowState = {
  /** Instant the axis measures TO (its right edge). */
  readonly end: Date | string | null;
  /** Instant the axis measures FROM (its left edge). */
  readonly start: Date | string | null;
  /** Window the geometry plots over; `null` when no bound is usable at all. */
  readonly window: SessionTimelineWindow | null;
};

/**
 * ISS-4833 / ISS-4821: resolve the Session Timeline's one window.
 *
 * The axis and the geometry both run on the PLOTTED-ACTIVITY window
 * ({@link resolveSessionTimelineWindow}): both ends anchored to rows the screen
 * actually draws, so the axis total reconciles with the "Activity phases" span
 * beneath it, a sweeper-stamped `endedAt` cannot inflate either end (FEA-3594),
 * and an event dated after a stale `endedAt` lands at its true fraction instead
 * of clamping to the right edge.
 *
 * ISS-5366: this was gated on `session-timeline-axis-reconciliation` while it
 * dark-launched. With the flag retired to its enabled state there is one
 * derivation left — the prior split, where the label measured
 * `startedAt → resolveSessionDurationEnd` while the geometry divided by
 * `startedAt → endedAt ?? updatedAt`, is exactly the two-window disagreement
 * this hook exists to prevent and is gone with the gate.
 *
 * Replaces `useSessionTimelineAxisEnd`, which resolved only the axis END and so
 * could not keep the geometry — or the axis START — on the same window.
 */
export function useSessionTimelineWindow(
  session: SessionTimelineWindowSource
): SessionTimelineWindowState {
  return useMemo(() => resolveTimelineAxis(session), [session]);
}

/** Pure core of {@link useSessionTimelineWindow}, so tests can drive it directly. */
export function resolveTimelineAxis(
  session: SessionTimelineWindowSource
): SessionTimelineWindowState {
  const window = resolveSessionTimelineWindow(session);
  if (!window) {
    // No usable bound anywhere: name the lifecycle anchors rather than a
    // fabricated window, and let each consumer keep its ordinal fallback.
    return {
      end: resolveSessionTimelineAxisEnd(
        session.endedAt,
        session.lastActivityAt,
        session.updatedAt
      ),
      start: session.startedAt ?? null,
      window: null,
    };
  }
  return {
    end: new Date(window.endMs),
    start: new Date(window.startMs),
    window,
  };
}

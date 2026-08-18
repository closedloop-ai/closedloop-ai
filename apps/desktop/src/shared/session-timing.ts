import { eventRole } from "./event-role.js";

export type SessionTiming = {
  activeAgentMs: number;
  waitingUserMs: number;
};

/**
 * Optional wall-clock window `[startMs, endMs]` the timing sum is clamped to.
 * FEA-3582: every inter-event gap is intersected with this span before it is
 * added to a bucket, so `activeAgentMs + waitingUserMs <= endMs - startMs`
 * (the session's wall time) is a HARD invariant. Without it, timeline events
 * that fall outside the resolved session span — a `metadata.messages` entry
 * timestamped before the declared `startedAt`, or a folded concurrent-subagent
 * event whose timestamp runs past the parent's last-activity end anchor — widen
 * the summed span past wall, producing the impossible "active time exceeds wall
 * time" (2h 57m active on a 2h 51m wall session, session 019f7d4c).
 */
export type SessionTimingBounds = { startMs: number; endMs: number };

export function computeSessionTiming(
  events: ReadonlyArray<{ eventType: string; createdAt: string }>,
  bounds?: SessionTimingBounds
): SessionTiming {
  let activeAgentMs = 0;
  let waitingUserMs = 0;

  if (events.length === 0) {
    return { activeAgentMs, waitingUserMs };
  }

  // A finite, well-ordered window enables clamping; otherwise fall back to the
  // unclamped raw-gap sum (behaviourally identical to pre-FEA-3582 callers).
  const clampWindow =
    bounds &&
    Number.isFinite(bounds.startMs) &&
    Number.isFinite(bounds.endMs) &&
    bounds.endMs >= bounds.startMs
      ? bounds
      : null;

  let prevRole = eventRole(events[0].eventType);
  let prevTime = new Date(events[0].createdAt).getTime();

  for (let i = 1; i < events.length; i++) {
    const role = eventRole(events[i].eventType);
    const time = new Date(events[i].createdAt).getTime();
    // Clamp the [prevTime, time) gap to the wall window before measuring it: an
    // interval starting before `startMs` or ending after `endMs` contributes
    // only its in-window portion, so no bucket can outrun wall time. A gap that
    // is wholly outside the window (or zero/negative) yields `lo >= hi` and
    // contributes nothing.
    const lo = clampWindow ? Math.max(prevTime, clampWindow.startMs) : prevTime;
    const hi = clampWindow ? Math.min(time, clampWindow.endMs) : time;
    const gap = hi - lo;

    if (Number.isFinite(gap) && gap > 0) {
      if (prevRole === "agent" && role === "human") {
        waitingUserMs += gap;
      } else if (prevRole !== "system") {
        activeAgentMs += gap;
      }
    }

    prevRole = role;
    prevTime = time;
  }

  return { activeAgentMs, waitingUserMs };
}

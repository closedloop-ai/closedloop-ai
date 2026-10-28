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

export type SessionTimingAccumulator = {
  push(event: { eventType: string; createdAt: string }): void;
  finish(): SessionTiming;
};

/** Incremental form of {@link computeSessionTiming} for ordered event streams. */
export function createSessionTimingAccumulator(
  bounds?: SessionTimingBounds
): SessionTimingAccumulator {
  let activeAgentMs = 0;
  let waitingUserMs = 0;
  let previousRole: ReturnType<typeof eventRole> | null = null;
  let previousTime = Number.NaN;
  const clampWindow =
    bounds &&
    Number.isFinite(bounds.startMs) &&
    Number.isFinite(bounds.endMs) &&
    bounds.endMs >= bounds.startMs
      ? bounds
      : null;

  return {
    push(event) {
      const role = eventRole(event.eventType);
      const time = new Date(event.createdAt).getTime();
      if (previousRole !== null) {
        const lo = clampWindow
          ? Math.max(previousTime, clampWindow.startMs)
          : previousTime;
        const hi = clampWindow ? Math.min(time, clampWindow.endMs) : time;
        const gap = hi - lo;
        const bucket = timingGapBucket(previousRole, role, gap);
        if (bucket === "waiting") {
          waitingUserMs += gap;
        } else if (bucket === "active") {
          activeAgentMs += gap;
        }
      }
      previousRole = role;
      previousTime = time;
    },
    finish() {
      return { activeAgentMs, waitingUserMs };
    },
  };
}

function timingGapBucket(
  previousRole: ReturnType<typeof eventRole>,
  role: ReturnType<typeof eventRole>,
  gap: number
): "active" | "waiting" | null {
  if (!(Number.isFinite(gap) && gap > 0)) {
    return null;
  }
  if (previousRole === "agent" && role === "human") {
    return "waiting";
  }
  return previousRole === "system" ? null : "active";
}

export function computeSessionTiming(
  events: ReadonlyArray<{ eventType: string; createdAt: string }>,
  bounds?: SessionTimingBounds
): SessionTiming {
  const accumulator = createSessionTimingAccumulator(bounds);
  for (const event of events) {
    accumulator.push(event);
  }
  return accumulator.finish();
}

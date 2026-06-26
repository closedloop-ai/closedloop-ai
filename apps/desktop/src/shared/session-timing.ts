import { eventRole } from "./event-role.js";

export type SessionTiming = {
  activeAgentMs: number;
  waitingUserMs: number;
};

export function computeSessionTiming(
  events: ReadonlyArray<{ eventType: string; createdAt: string }>
): SessionTiming {
  let activeAgentMs = 0;
  let waitingUserMs = 0;

  if (events.length === 0) {
    return { activeAgentMs, waitingUserMs };
  }

  let prevRole = eventRole(events[0].eventType);
  let prevTime = new Date(events[0].createdAt).getTime();

  for (let i = 1; i < events.length; i++) {
    const role = eventRole(events[i].eventType);
    const time = new Date(events[i].createdAt).getTime();
    const gap = time - prevTime;

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

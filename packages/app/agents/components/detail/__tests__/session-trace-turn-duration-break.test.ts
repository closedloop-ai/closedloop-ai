import type { SyncedAgentSessionEvent } from "@repo/api/src/types/agent-session";
import { projectAgentSessionTurnItemsFromEvents } from "@repo/lib/sessions/agent-session-detail-projection";
import { describe, expect, it } from "vitest";
import { buildTraceGroups } from "../session-trace-groups";

/**
 * ISS-12467 review (tamsinb): the DB path drops the `TurnDuration` row, and the
 * Claude parser drops synthetic user records (task notifications, /loop
 * re-injections), so two agent turns can sit back to back with no prompt
 * between them. The skipped row must still end its turn, or both coalesce into
 * one bubble whose duration spans both turns and the wait.
 */
describe("a skipped TurnDuration row between agent turns", () => {
  it("keeps the two turns as two agent groups with their own durations", () => {
    const groups = buildTraceGroups(
      projectAgentSessionTurnItemsFromEvents({
        sessionId: "sess-1",
        harness: "claude-code",
        primaryModel: "claude-opus",
        humanActor: { name: "Ada", color: "var(--human)" },
        agents: [],
        tokenUsageByModel: [],
        metadata: {
          messages: [
            {
              role: "assistant",
              timestamp: "2026-06-18T12:00:50.000Z",
              text: "First turn",
            },
            {
              role: "assistant",
              timestamp: "2026-06-18T12:20:00.000Z",
              text: "Second turn",
            },
          ],
        },
        events: [turnDuration("2026-06-18T12:00:52.900Z")],
      })
    );

    const agentGroups = groups.filter(
      (group) => group.kind === "msg" && group.side === "agent"
    );
    expect(agentGroups).toHaveLength(2);
    for (const group of agentGroups) {
      expect(group.kind === "msg" && group.segments).toHaveLength(1);
    }
  });

  it("still coalesces consecutive agent items with no TurnDuration between them", () => {
    const groups = buildTraceGroups(
      projectAgentSessionTurnItemsFromEvents({
        sessionId: "sess-1",
        harness: "claude-code",
        primaryModel: "claude-opus",
        humanActor: { name: "Ada", color: "var(--human)" },
        agents: [],
        tokenUsageByModel: [],
        metadata: {
          messages: [
            {
              role: "assistant",
              timestamp: "2026-06-18T12:00:50.000Z",
              text: "First part",
            },
            {
              role: "assistant",
              timestamp: "2026-06-18T12:00:51.000Z",
              text: "Second part",
            },
          ],
        },
        events: [],
      })
    );

    expect(
      groups.filter((group) => group.kind === "msg" && group.side === "agent")
    ).toHaveLength(1);
  });
});

function turnDuration(createdAt: string): SyncedAgentSessionEvent {
  return {
    externalEventId: `turn-duration-${createdAt}`,
    eventType: "TurnDuration",
    summary: "2900",
    createdAt,
  };
}

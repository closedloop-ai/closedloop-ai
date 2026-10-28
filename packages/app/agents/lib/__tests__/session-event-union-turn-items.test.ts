import type {
  AgentSessionDetail,
  SyncedAgentSessionEvent,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../../components/detail/agent-session-detail-fixtures";
import {
  buildTurnItemsFromEventUnion,
  resolveProjectedActorIdentity,
} from "../session-event-union-turn-items";

const CONTEXT = {
  harness: "claude",
  primaryModel: "gpt-5.5",
  humanActor: { name: "Panel Name", color: "#123456" },
};

/**
 * The fixture's hand-written `turnItems` are not the projection's output, so
 * the union is compared against `session.agents` and `session.metadata`, the
 * inputs the projection actually reads.
 */
function truncatedSession(
  overrides: Partial<AgentSessionDetail> = {}
): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    eventsTruncated: true,
    metadata: {
      messages: [
        {
          role: "human",
          timestamp: "2026-06-10T12:01:00.000Z",
          text: "Please inspect the shared session detail screen.",
        },
      ],
    },
    ...overrides,
  });
}

function pageEvents(count: number, fromMs: number): SyncedAgentSessionEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    externalEventId: `page-${index}`,
    agentExternalId: "agent-main",
    eventType: "tool_use",
    toolName: `page-tool-${index}`,
    createdAt: new Date(fromMs + index * 1000).toISOString(),
  }));
}

function rowTime(item: TurnItem): number {
  return "tMs" in item ? item.tMs : Number.NEGATIVE_INFINITY;
}

describe("resolveProjectedActorIdentity", () => {
  it("reads the producer's sessionId and human name off the prefix rows", () => {
    const session = truncatedSession();
    expect(
      resolveProjectedActorIdentity(session.turnItems, {
        sessionId: "fallback-id",
        humanName: "Fallback",
      })
    ).toEqual({
      sessionId:
        session.turnItems?.[0] && "actor" in session.turnItems[0]
          ? session.turnItems[0].actor.sessionId
          : "unexpected",
      humanName: "Ada Lovelace",
    });
  });

  it("falls back per field when the prefix carries no such row", () => {
    expect(
      resolveProjectedActorIdentity([], {
        sessionId: "fallback-id",
        humanName: null,
      })
    ).toEqual({ sessionId: "fallback-id", humanName: null });
    expect(
      resolveProjectedActorIdentity(undefined, {
        sessionId: "fallback-id",
        humanName: "You",
      })
    ).toEqual({ sessionId: "fallback-id", humanName: "You" });
  });
});

describe("buildTurnItemsFromEventUnion", () => {
  it("orders the union by time across the prefix boundary and keeps one card per subagent", () => {
    const session = truncatedSession();
    const lastPrefixMs = Date.parse(session.events.at(-1)?.createdAt ?? "");
    const items = buildTurnItemsFromEventUnion({
      session,
      pageEvents: pageEvents(3, lastPrefixMs + 60_000),
      context: CONTEXT,
      eventsTruncated: true,
    });
    const times = items.map(rowTime).filter((time) => Number.isFinite(time));
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]).toBeGreaterThanOrEqual(times[index - 1] as number);
    }
    const subagentRows = items.filter((item) => item.type === "subagent");
    const subagents = session.agents.filter(
      (agent) => agent.parentExternalAgentId !== null
    );
    expect(subagents).toHaveLength(2);
    expect(subagentRows).toHaveLength(subagents.length);
    const toolLabels = items
      .filter((item) => item.type === "tools")
      .flatMap((item) => ("items" in item ? item.items : []))
      .map((tool) => tool.label);
    expect(toolLabels).toEqual(expect.arrayContaining(["page-tool-2"]));
  });

  it("stamps the prefix's actor identity on the union rows", () => {
    const session = truncatedSession();
    const items = buildTurnItemsFromEventUnion({
      session,
      pageEvents: pageEvents(1, Date.now()),
      context: CONTEXT,
    });
    const prompt = items.find((item) => item.type === "prompt");
    expect(prompt && "actor" in prompt ? prompt.actor.human : null).toBe(
      "Ada Lovelace"
    );
    expect(prompt && "actor" in prompt ? prompt.actor.color : null).toBe(
      CONTEXT.humanActor.color
    );
  });

  it("carries the desktop's cost points through the union", () => {
    const session = truncatedSession({
      tokenEventCostPoints: [
        { tMs: Date.parse("2026-06-10T12:02:30.000Z"), costUsd: 1.5 },
      ],
    });
    const items = buildTurnItemsFromEventUnion({
      session,
      pageEvents: pageEvents(1, Date.parse("2026-06-10T13:00:00.000Z")),
      context: CONTEXT,
    });
    const costs = items.flatMap((item) =>
      "costDelta" in item && typeof item.costDelta === "number"
        ? [item.costDelta]
        : []
    );
    expect(costs.length).toBeGreaterThan(0);
    expect(Math.max(...costs)).toBeCloseTo(1.5);
  });
});

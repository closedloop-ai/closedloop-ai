import type {
  SessionTimelineEvent,
  SyncedAgentSessionEvent,
  SyncedAgentSessionTokenUsage,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  agent,
  event,
} from "./agent-session-detail-projection.test-helpers.ts";
import {
  projectAgentSessionTimelineEvents,
  projectAgentSessionTurnItems,
  projectAgentSessionTurnItemsFromEvents,
} from "./agent-session-detail-projection.ts";

const T0 = "2026-06-17T00:00:01.000Z";
const T1 = "2026-06-17T00:00:02.000Z";

const baseInput = {
  sessionId: "sess-1",
  harness: "claude-code",
  primaryModel: "claude-opus",
  humanActor: { name: "Ada", color: "var(--human)" },
  events: [] as SyncedAgentSessionEvent[],
  tokenUsageByModel: [] as SyncedAgentSessionTokenUsage[],
};

function turnItems(timeline: SessionTimelineEvent[]) {
  return projectAgentSessionTurnItems({ ...baseInput, timeline, agents: [] });
}

describe("projectAgentSessionTimelineEvents — metadata edges", () => {
  it("assigns a duplicated command turn id to only the first human message at that timestamp", () => {
    const rows = projectAgentSessionTimelineEvents([], {
      metadata: {
        slashCommands: [
          { name: "/review", timestamp: T0, userTurnId: "turn-1" },
          { name: "/review", timestamp: T0, userTurnId: "turn-1" },
        ],
        messages: [
          { role: "human", timestamp: T0, text: "a" },
          { role: "human", timestamp: T0, text: "b" },
        ],
      },
    });

    expect(rows.map((row) => row.transcriptIdentity?.userTurnId)).toEqual([
      "turn-1",
      undefined,
    ]);
  });

  it("leaves detail undefined, not null, for a message with no text", () => {
    const rows = projectAgentSessionTimelineEvents([], {
      metadata: { messages: [{ role: "human", timestamp: T0 }] },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty("detail", undefined);
  });

  it("sorts a row with an unparseable timestamp after every parseable one", () => {
    const rows = projectAgentSessionTimelineEvents(
      [event({ externalEventId: "e1", eventType: "note", createdAt: T1 })],
      {
        metadata: {
          messages: [{ role: "human", timestamp: "not-a-date", text: "late" }],
        },
      }
    );

    expect(rows.map((row) => row.t)).toEqual([T1, "not-a-date"]);
  });

  it("orders a plain event after a tool event at the same timestamp", () => {
    const rows = projectAgentSessionTimelineEvents([
      event({ externalEventId: "plain", eventType: "note", createdAt: T0 }),
      event({
        externalEventId: "tool",
        eventType: "PostToolUse",
        toolName: "Bash",
        createdAt: T0,
      }),
    ]);

    expect(rows.map((row) => row.transcriptIdentity?.eventId)).toEqual([
      "tool",
      "plain",
    ]);
  });

  it("truncates an over-limit data-derived detail to 240 characters", () => {
    const rows = projectAgentSessionTimelineEvents([
      event({
        externalEventId: "long",
        eventType: "note",
        createdAt: T0,
        data: { file_path: "x".repeat(300) },
      }),
    ]);

    expect(rows[0]?.detail).toBe(`${"x".repeat(237)}...`);
  });
});

describe("projectAgentSessionTurnItems — optional-field fallbacks", () => {
  it("renders an empty prompt text when a human event has no detail", () => {
    const [item] = turnItems([{ t: T0, tMs: Date.parse(T0), kind: "human" }]);

    expect(item?.type === "prompt" && item.text).toBe("");
  });

  it("falls back from detail to title to kind for a generic event's text", () => {
    const items = turnItems([
      { t: T0, tMs: Date.parse(T0), kind: "event", title: "Titled" },
      { t: T1, tMs: Date.parse(T1), kind: "result" },
    ]);

    expect(items.map((item) => item.type === "event" && item.text)).toEqual([
      "Titled",
      "result",
    ]);
  });

  it("labels a titleless tool row by its kind", () => {
    const [item] = turnItems([{ t: T0, tMs: Date.parse(T0), kind: "edit" }]);

    expect(item?.type === "tools" && item.items[0]?.label).toBe("edit");
  });

  it("resolves the detail state from inline fields when the event carries none", () => {
    const [item] = turnItems([
      {
        t: T0,
        tMs: Date.parse(T0),
        kind: "tool",
        title: "Bash",
        toolInput: "ls",
      },
    ]);

    expect(item?.type === "tools" && item.items[0]?.detailState).toBe(
      "available"
    );
  });

  it("marks an errored generic event with the red dot", () => {
    const [item] = turnItems([
      { t: T0, tMs: Date.parse(T0), kind: "event", title: "x", err: true },
    ]);

    expect(item?.type === "event" && item.dot).toBe("r");
  });

  it("breaks a time tie between an event and a subagent by row", () => {
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [
        {
          t: T0,
          tMs: Date.parse(T0),
          tl: 99,
          kind: "event",
          title: "late row",
        },
      ],
      agents: [
        agent({
          externalAgentId: "sub-1",
          name: "Helper",
          type: "subagent",
          status: "completed",
          startedAt: T0,
        }),
      ],
    });

    expect(items.map((item) => item.type)).toEqual(["subagent", "event"]);
  });
});

describe("projectAgentSessionTurnItemsFromEvents (ISS-12277)", () => {
  it("derives the timeline from events + metadata exactly as the two-step projection does", () => {
    const events = [
      event({
        externalEventId: "tool-1",
        eventType: "PostToolUse",
        toolName: "Bash",
        createdAt: T1,
      }),
    ];
    const metadata = {
      messages: [
        { role: "human", timestamp: T0, text: "Run the tests." },
        { role: "assistant", timestamp: T0, text: "Running.", model: "m-1" },
      ],
    };

    const items = projectAgentSessionTurnItemsFromEvents({
      ...baseInput,
      events,
      metadata,
      agents: [],
    });

    expect(items).toEqual(
      projectAgentSessionTurnItems({
        ...baseInput,
        events,
        timeline: projectAgentSessionTimelineEvents(events, { metadata }),
        agents: [],
      })
    );
    expect(
      items.map((item) => [item.type, "model" in item ? item.model : null])
    ).toEqual([
      ["prompt", null],
      ["say", "m-1"],
      ["tools", null],
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { buildSessionDetailContent } from "../detail-content";

const PAYLOAD_MARKER = "iss-5074-payload-marker";
const EVENT_CREATED_AT = "2026-01-01T01:30:00.000Z";

describe("buildSessionDetailContent event payload serialization", () => {
  it("does not serialize the payload of an ordinary timeline event", () => {
    const content = buildSessionDetailContent(
      createAgentSessionDetailFixture({
        events: [
          {
            externalEventId: "tool-event",
            agentExternalId: "agent-main",
            eventType: "tool_use",
            toolName: "node",
            summary: "Ran a tool.",
            createdAt: EVENT_CREATED_AT,
            data: { note: PAYLOAD_MARKER },
          },
        ],
      })
    );

    // Pin the population FIRST. Without this the negative assertion below is
    // satisfied by `groups === []`, so a regression that dropped events from
    // `buildEventData` entirely — or a fixture change that stopped applying
    // `events` — would leave this test green while the behavior it claims to
    // pin was gone.
    const timelineEvents = content.eventData.groups.flatMap(
      (group) => group.events
    );
    expect(timelineEvents).toHaveLength(1);
    expect(timelineEvents[0]?.title).toBe("node");

    // The timeline renders summary/metadata/detail only, so no event carries a
    // pretty-printed copy of its payload — on desktop, where `data` is hydrated
    // from local SQLite, that was a per-event string nothing read.
    expect(JSON.stringify(content.eventData.groups)).not.toContain(
      PAYLOAD_MARKER
    );
  });

  it("still serializes the payload of an error event for the errors panel", () => {
    const content = buildSessionDetailContent(
      createAgentSessionDetailFixture({
        events: [
          {
            externalEventId: "error-event",
            agentExternalId: "agent-main",
            eventType: "tool_error",
            summary: "Tool failed.",
            createdAt: EVENT_CREATED_AT,
            data: { note: PAYLOAD_MARKER },
          },
        ],
      })
    );

    expect(content.errors).toHaveLength(1);
    expect(content.errors[0]?.rawData).toContain(PAYLOAD_MARKER);
  });
});

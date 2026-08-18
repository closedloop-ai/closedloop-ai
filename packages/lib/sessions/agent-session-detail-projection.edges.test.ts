/**
 * ISS-5292: edge-case branches of the agent-session detail projection.
 *
 * Split from `agent-session-detail-projection.test.ts` (root AGENTS.md 1,000-line
 * ceiling). That file keeps the main `projectAgentSessionTurnItems` behavior and
 * `deriveAgentSessionFallbackState`; this one owns the optional-field fallbacks
 * and the truncation/scoping guards: timeline events missing `tMs`/`tl`, the
 * ISS-5075 `eventsTruncated` duration guard, `projectAgentSessionTimelineEvents`
 * optional transcriptIdentity fields, and subagent body scoping.
 */
import type {
  SessionTimelineEvent,
  SyncedAgentSessionAgent,
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
} from "./agent-session-detail-projection.ts";
import { commandUserTurnId } from "./command-user-turn-id.ts";

describe("projectAgentSessionTurnItems — timeline events without explicit tMs or tl", () => {
  // SessionTimelineEvent.tMs and .tl are both optional. The projection falls
  // back to Date.parse(event.t) for tMs and to the array index for tl. All
  // these ?? fallback arms would stay uncovered if every test provides explicit
  // values. A single test with no tMs/tl exercises them all simultaneously:
  //   line 691: event.tMs ?? Date.parse(event.t)
  //   line 692: event.tl ?? index
  //   line 755: first.tl ?? startIndex  (tool-items callId)
  //   line 763: first.tl ?? startIndex  (tools._row)
  //   line 765: first.tMs ?? Date.parse(first.t)  (tools.tMs)
  //   line 766: last.tMs ?? Date.parse(last.t)   (tools.endMs)
  //   line 934: event.tMs ?? Date.parse(event.t)  (safeTimelineMs sort key)

  const baseInput = {
    sessionId: "sess-1",
    harness: "claude-code",
    primaryModel: "claude-opus",
    humanActor: { name: "Ada", color: "var(--human)" },
    events: [] as SyncedAgentSessionEvent[],
    tokenUsageByModel: [] as SyncedAgentSessionTokenUsage[],
  };

  it("derives tMs from event.t and _row from array position when tMs and tl are absent", () => {
    const t0 = "2026-06-17T00:00:01.000Z";
    const t1 = "2026-06-17T00:00:02.000Z";
    const timeline: SessionTimelineEvent[] = [
      // No tMs, no tl — fallback arms must fire.
      { t: t0, kind: "human", detail: "Q" },
      { t: t1, kind: "tool", title: "Bash", detail: "ls" },
    ];

    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
    });

    const prompt = items.find((item) => item.type === "prompt");
    const tools = items.find((item) => item.type === "tools");
    if (prompt?.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    if (tools?.type !== "tools") {
      throw new Error("expected tools turn");
    }
    // tMs must be derived from Date.parse(event.t).
    expect(prompt.tMs).toBe(Date.parse(t0));
    expect(tools.tMs).toBe(Date.parse(t1));
    expect(tools.endMs).toBe(Date.parse(t1));
    // _row falls back to the array index on BOTH turns, and the tool item's
    // callId is minted from that same fallback. Asserting all three, because the
    // `first.tl ?? startIndex` arms feeding `tools._row` and `items[0].callId`
    // otherwise execute without any assertion able to fail.
    expect(prompt._row).toBe(0);
    expect(tools._row).toBe(1);
    expect(tools.items[0]?.callId).toBe("1-0");
  });
});

describe("projectAgentSessionTurnItems — eventsTruncated handling", () => {
  const baseInput = {
    sessionId: "sess-1",
    harness: "claude-code",
    primaryModel: "claude-opus",
    humanActor: { name: "Ada", color: "var(--human)" },
    events: [] as SyncedAgentSessionEvent[],
    tokenUsageByModel: [] as SyncedAgentSessionTokenUsage[],
  };

  // ISS-5075: over a truncated prefix, a sub-agent without endedAt has no
  // reliable end anchor → duration must be null (not a fabricated undercount).
  //
  // The fixture carries an `updatedAt` deliberately. Without it there is no end
  // anchor at all, `resolveAgentEndMs` returns NaN, and the later finite check
  // returns null on its own — so deleting the whole ISS-5075 guard would leave
  // the assertion green. With `updatedAt` present the guard is the ONLY reason
  // the answer is null, which the paired non-truncated case below proves by
  // rendering the duration that `updatedAt` yields.
  const runningAgent = (): SyncedAgentSessionAgent =>
    agent({
      externalAgentId: "sub-1",
      name: "Running",
      type: "subagent",
      subagentType: "Explore",
      status: "running",
      startedAt: "2026-06-17T00:00:00.000Z",
      // No endedAt — agent is still in progress — but `updatedAt` WOULD anchor.
      updatedAt: "2026-06-17T00:01:30.000Z",
    });

  it("sets subagent duration to null when events are truncated and the agent has no endedAt", () => {
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents: [runningAgent()],
      eventsTruncated: true,
    });

    const sub = items[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    expect(sub.duration).toBeNull();
  });

  it("renders the updatedAt-anchored duration for the same agent when events are NOT truncated", () => {
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents: [runningAgent()],
    });

    const sub = items[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    expect(sub.duration).toBe("1m 30s");
  });
});

describe("projectAgentSessionTimelineEvents — transcriptIdentity optional fields", () => {
  it("threads providerToolUseId into the timeline event transcriptIdentity when present", () => {
    const rows = projectAgentSessionTimelineEvents([
      event({
        externalEventId: "e1",
        eventType: "PostToolUse",
        toolName: "Bash",
        createdAt: "2026-06-17T00:00:00.000Z",
        providerToolUseId: "toolu_abc123",
      }),
    ]);
    expect(rows[0]?.transcriptIdentity?.providerToolUseId).toBe("toolu_abc123");
  });

  it("threads agentExternalId into the timeline event transcriptIdentity when present", () => {
    const rows = projectAgentSessionTimelineEvents([
      event({
        externalEventId: "e2",
        eventType: "PostToolUse",
        toolName: "Read",
        createdAt: "2026-06-17T00:00:00.000Z",
        agentExternalId: "agent-456",
      }),
    ]);
    expect(rows[0]?.transcriptIdentity?.externalAgentId).toBe("agent-456");
  });

  it("classifies system metadata messages as event-kind timeline rows", () => {
    // messageTimelineKind falls through to return "event" for role "system".
    const metadata = {
      messages: [
        {
          role: "system",
          timestamp: "2026-06-17T00:00:00.000Z",
          text: "System context injected",
        },
      ],
    };
    const rows = projectAgentSessionTimelineEvents([], { metadata });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("event");
    expect(rows[0]?.detail).toBe("System context injected");
  });

  it("attaches a derived command turn ID from slashCommands to the matching human message", () => {
    // commandTurnIdsByTimestamp: exercises the slashCommands array branch,
    // valid-entry branch (name + timestamp both present), the new-entry path,
    // and the duplicate-timestamp push path.
    const timestamp = "2026-06-17T00:00:01.000Z";
    const metadata = {
      messages: [
        { role: "human", timestamp, text: "run commands" },
        // Second human turn at the SAME timestamp — reads the queued duplicate.
        { role: "human", timestamp, text: "and the other one" },
      ],
      slashCommands: [
        // Valid entry → added to the map at `timestamp`.
        { name: "clear", timestamp },
        // Second valid entry with same timestamp → duplicate path (push).
        { name: "build", timestamp },
        // Invalid entry (no name) → skipped by the name && timestamp guard.
        { timestamp },
      ],
    };
    const rows = projectAgentSessionTimelineEvents([], { metadata });
    const humans = rows.filter((r) => r.kind === "human");
    // Asserted as the exact minted id, not `toMatch(/^command:/)`: the regex
    // passes for ANY command entry, so it cannot tell "clear" from "build" and a
    // wrong-entry regression would be invisible.
    expect(humans[0]?.transcriptIdentity?.userTurnId).toBe(
      commandUserTurnId(
        { name: "clear", timestamp, userTurnId: null, normalizedName: null },
        0
      )
    );
    // The SECOND human message at the same timestamp consumes the second queued
    // entry. This is what makes the duplicate-timestamp `existing.push(turnId)`
    // path observable — with one human message the pushed entry is never read,
    // so disabling the push leaves the first assertion green.
    expect(humans[1]?.transcriptIdentity?.userTurnId).toBe(
      commandUserTurnId(
        { name: "build", timestamp, userTurnId: null, normalizedName: null },
        1
      )
    );
  });
});

describe("projectAgentSessionTurnItems — subagent body and transcriptIdentity", () => {
  const baseInput = {
    sessionId: "sess-1",
    harness: "claude-code",
    primaryModel: "claude-opus",
    humanActor: { name: "Ada", color: "var(--human)" },
    tokenUsageByModel: [] as SyncedAgentSessionTokenUsage[],
  };

  it("includes agentId in subagent transcriptIdentity when agent.id is set", () => {
    // agentTranscriptIdentity: `agent.id ? { agentId: agent.id } : {}` —
    // the truthy arm is never hit when agent.id is absent.
    const agents: SyncedAgentSessionAgent[] = [
      {
        ...agent({
          externalAgentId: "sub-1",
          name: "Explorer",
          type: "subagent",
          status: "completed",
          startedAt: "2026-06-17T00:00:00.000Z",
          endedAt: "2026-06-17T00:01:00.000Z",
        }),
        id: "row-id-42",
      },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      events: [],
      timeline: [],
      agents,
    });
    const sub = items[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    expect(sub.transcriptIdentity?.agentId).toBe("row-id-42");
  });

  it("omits timestamp from transcriptIdentity when subagent has no startedAt", () => {
    // agentTranscriptIdentity: `timestamp ? { timestamp, ... } : {}` — the
    // falsy arm fires when the subagent has no start anchor (t is null).
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-2",
        name: "Timeless",
        type: "subagent",
        status: "completed",
        // No startedAt → t = null
      }),
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      events: [],
      timeline: [],
      agents,
    });
    const sub = items[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    expect(sub.transcriptIdentity?.timestamp).toBeUndefined();
  });

  it("populates subagent body with events tagged to the agent's externalAgentId", () => {
    // agentEventTimestamps / buildSubagentBody: `event.agentExternalId ===
    // agent.externalAgentId` — the TRUE arm (and the FALSE skip in the body
    // loop) are never hit when events is empty. An event without toolName also
    // covers the `event.toolName ? "tool" : "event"` FALSE arm.
    const agentEvents: SyncedAgentSessionEvent[] = [
      event({
        externalEventId: "sub-event-1",
        eventType: "SessionStart", // no toolName → kind = "event" in body
        createdAt: "2026-06-17T00:00:30.000Z",
        agentExternalId: "sub-3",
      }),
      event({
        externalEventId: "unrelated-event",
        eventType: "PostToolUse",
        toolName: "Bash",
        createdAt: "2026-06-17T00:00:31.000Z",
        // Different agentExternalId → filtered out of sub-3's body.
        agentExternalId: "other-agent",
      }),
    ];
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-3",
        name: "Scoped",
        type: "subagent",
        status: "completed",
        startedAt: "2026-06-17T00:00:00.000Z",
        endedAt: "2026-06-17T00:01:00.000Z",
      }),
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      events: agentEvents,
      timeline: [],
      agents,
    });
    const sub = items[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    // Asserted over the WHOLE body, not `body.filter(kind === "event")`: the
    // unrelated event carries a toolName, so it projects with kind "tool" and a
    // kind-filtered view can never see it — dropping the `agentExternalId`
    // scoping guard entirely would leave such an assertion green. The full body
    // is the only view in which cross-agent leakage is observable.
    expect(sub.body.map((line) => line.text)).toEqual([
      "SessionStart",
      "completed",
    ]);
    expect(sub.body.some((line) => line.text === "Bash")).toBe(false);
  });
});

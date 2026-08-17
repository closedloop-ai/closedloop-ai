import type {
  SessionTimelineEvent,
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
  SyncedAgentSessionTokenUsage,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { projectAgentSessionTurnItems } from "./agent-session-detail-projection.ts";

function agent(
  overrides: Partial<SyncedAgentSessionAgent> &
    Pick<
      SyncedAgentSessionAgent,
      "externalAgentId" | "name" | "type" | "status"
    >
): SyncedAgentSessionAgent {
  return { ...overrides };
}

const baseInput = {
  sessionId: "sess-1",
  harness: "claude-code",
  primaryModel: "claude-opus",
  humanActor: { name: "Ada", color: "var(--human)" },
  events: [] as SyncedAgentSessionEvent[],
  tokenUsageByModel: [] as SyncedAgentSessionTokenUsage[],
};

describe("attributeTokenEventCosts — session-level cost column", () => {
  it("attributes a token event before the first cost-bearing turn to the first turn", () => {
    const timeline: SessionTimelineEvent[] = [
      {
        t: "t0",
        tMs: 1000,
        kind: "human",
        title: "Q",
        detail: "Question",
        tl: 0,
      },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents: [{ tMs: 500, costUsd: 0.01 }],
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    expect(prompt.costDelta).toBe(0.01);
    expect(prompt.cum).toBe(0.01);
  });

  it("attributes a token event between a prompt and agent turn to the agent turn", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
      {
        t: "t1",
        tMs: 2000,
        kind: "say",
        title: "opus",
        detail: "Answer",
        tl: 1,
      },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents: [{ tMs: 1000, costUsd: 0.05 }],
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    const say = items[1]!;
    if (say.type !== "say") {
      throw new Error("expected say turn");
    }
    expect(prompt.costDelta).toBe(0);
    expect(say.costDelta).toBe(0.05);
  });

  it("attributes a token event whose tMs matches a turn's tMs to that turn", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
      {
        t: "t1",
        tMs: 1000,
        kind: "say",
        title: "opus",
        detail: "Answer",
        tl: 1,
      },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents: [{ tMs: 1000, costUsd: 0.02 }],
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    const say = items[1]!;
    if (say.type !== "say") {
      throw new Error("expected say turn");
    }
    expect(prompt.costDelta).toBe(0);
    expect(say.costDelta).toBe(0.02);
  });

  it("attributes a token event after the last turn to the last cost-bearing turn", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents: [{ tMs: 5000, costUsd: 0.03 }],
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    expect(prompt.costDelta).toBe(0.03);
    expect(prompt.cum).toBe(0.03);
  });

  it("sum of all costDelta equals the sum of input costUsd", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
      {
        t: "t1",
        tMs: 1000,
        kind: "say",
        title: "opus",
        detail: "Answer",
        tl: 1,
      },
      { t: "t2", tMs: 2000, kind: "tool", title: "Bash", detail: "ls", tl: 2 },
    ];
    const tokenEvents = [
      { tMs: 500, costUsd: 0.01 },
      { tMs: 1500, costUsd: 0.02 },
      { tMs: 2500, costUsd: 0.03 },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents,
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    const say = items[1]!;
    if (say.type !== "say") {
      throw new Error("expected say turn");
    }
    const tools = items[2]!;
    if (tools.type !== "tools") {
      throw new Error("expected tools turn");
    }

    const totalDelta =
      (prompt.costDelta ?? 0) + (say.costDelta ?? 0) + (tools.costDelta ?? 0);
    const totalInput = tokenEvents.reduce((sum, e) => sum + e.costUsd, 0);
    expect(totalDelta).toBeCloseTo(totalInput, 10);
  });

  it("cum is monotonically non-decreasing across cost-bearing turns", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
      { t: "t1", tMs: 1000, kind: "say", title: "opus", detail: "A", tl: 1 },
      { t: "t2", tMs: 2000, kind: "tool", title: "Bash", detail: "ls", tl: 2 },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents: [
        { tMs: 500, costUsd: 0.01 },
        { tMs: 1500, costUsd: 0.02 },
        { tMs: 2500, costUsd: 0.03 },
      ],
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    const say = items[1]!;
    if (say.type !== "say") {
      throw new Error("expected say turn");
    }
    const tools = items[2]!;
    if (tools.type !== "tools") {
      throw new Error("expected tools turn");
    }

    expect(prompt.cum).toBeLessThanOrEqual(say.cum);
    expect(say.cum).toBeLessThanOrEqual(tools.cum);
  });

  it("a zero-cost token event contributes 0 to costDelta", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents: [{ tMs: 500, costUsd: 0 }],
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    expect(prompt.costDelta).toBe(0);
    expect(prompt.cum).toBe(0);
  });

  it("leaves costDelta undefined and cum at 0 when tokenEvents is not provided", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    expect(prompt.costDelta).toBeUndefined();
    expect(prompt.cum).toBe(0);
  });

  it("ignores token events with NaN tMs", () => {
    const timeline: SessionTimelineEvent[] = [
      {
        tl: 0,
        t: "2026-01-01T00:01:00.000Z",
        tMs: Date.parse("2026-01-01T00:01:00.000Z"),
        kind: "say",
        title: "say",
      },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents: [
        { tMs: Number.NaN, costUsd: 0.5 },
        { tMs: Date.parse("2026-01-01T00:02:00.000Z"), costUsd: 0.1 },
      ],
    });
    const say = items.find((item) => item.type === "say");
    if (say?.type !== "say") {
      throw new Error("expected say turn");
    }
    expect(say.costDelta).toBe(0.1);
    expect(say.cum).toBe(0.1);
  });

  it("does not throw when there are no cost-bearing turns and tokenEvents is non-empty", () => {
    const timeline: SessionTimelineEvent[] = [
      {
        t: "t0",
        tMs: 0,
        kind: "event",
        title: "SessionStart",
        detail: "SessionStart",
        tl: 0,
      },
    ];
    expect(() =>
      projectAgentSessionTurnItems({
        ...baseInput,
        timeline,
        agents: [],
        tokenEvents: [{ tMs: 500, costUsd: 0.01 }],
      })
    ).not.toThrow();
  });
});

describe("attributeTokenEventCosts — sub-agent cost label (FEA-4178)", () => {
  it("leaves subagent tokens and cost null when no token events attribute to its span", () => {
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-1",
        name: "Explorer",
        type: "subagent",
        subagentType: "Explore",
        status: "completed",
        startedAt: "2026-06-17T00:00:00.000Z",
        endedAt: "2026-06-17T00:01:00.000Z",
      }),
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents,
      // No token events at all → no attributed cost, so cost stays null and the
      // collapsed box shows duration only (never a fabricated session total).
    });

    const sub = items[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    expect(sub.tokens).toBeNull();
    expect(sub.cost).toBeNull();
  });

  it("labels a lone sub-agent from its timestamp delta when events are ownerless", () => {
    const sub1Start = Date.parse("2026-06-17T00:00:00.000Z");
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-1",
        name: "Explorer",
        type: "subagent",
        subagentType: "Explore",
        status: "completed",
        startedAt: "2026-06-17T00:00:00.000Z",
        endedAt: "2026-06-17T00:02:00.000Z",
      }),
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents,
      // Ownerless events (no agentExternalId) — a lone sub-agent trusts its
      // timestamp delta.
      tokenEvents: [
        { tMs: sub1Start + 30_000, costUsd: 0.1 },
        { tMs: sub1Start + 90_000, costUsd: 0.2 },
      ],
    });

    const sub = items[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    expect(sub.costDelta).toBeCloseTo(0.3, 10);
    expect(sub.cost).toBe("$0.30");
    expect(sub.tokens).toBeNull();
  });

  it("meters overlapping sub-agents by ownership so neither wears the other's spend", () => {
    // A and B overlap in time. Ownership-tagged events price each to its owner.
    const start = Date.parse("2026-06-17T00:00:00.000Z");
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-A",
        name: "Explorer",
        type: "subagent",
        subagentType: "Explore",
        status: "completed",
        startedAt: "2026-06-17T00:00:00.000Z",
        endedAt: "2026-06-17T00:05:00.000Z",
      }),
      agent({
        externalAgentId: "sub-B",
        name: "Builder",
        type: "subagent",
        subagentType: "Build",
        status: "completed",
        startedAt: "2026-06-17T00:01:00.000Z",
        endedAt: "2026-06-17T00:06:00.000Z",
      }),
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents,
      tokenEvents: [
        // A's own spend, some of it inside B's window.
        { tMs: start + 30_000, costUsd: 0.1, agentExternalId: "sub-A" },
        { tMs: start + 120_000, costUsd: 0.2, agentExternalId: "sub-A" },
        // B's own spend.
        { tMs: start + 130_000, costUsd: 0.5, agentExternalId: "sub-B" },
      ],
    });

    const subA = items.find(
      (i) => i.type === "subagent" && i.sub === "Explorer"
    );
    const subB = items.find(
      (i) => i.type === "subagent" && i.sub === "Builder"
    );
    if (subA?.type !== "subagent" || subB?.type !== "subagent") {
      throw new Error("expected both subagent turns");
    }
    // Metered by ownership: A carries exactly its own 0.1 + 0.2, B its own 0.5 —
    // no timestamp bleed even though the spans overlap.
    expect(subA.cost).toBe("$0.30");
    expect(subB.cost).toBe("$0.50");
  });

  it("omits both labels when overlapping sub-agents have ownerless events (ambiguous)", () => {
    const start = Date.parse("2026-06-17T00:00:00.000Z");
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-A",
        name: "Explorer",
        type: "subagent",
        subagentType: "Explore",
        status: "completed",
        startedAt: "2026-06-17T00:00:00.000Z",
        endedAt: "2026-06-17T00:05:00.000Z",
      }),
      agent({
        externalAgentId: "sub-B",
        name: "Builder",
        type: "subagent",
        subagentType: "Build",
        status: "completed",
        startedAt: "2026-06-17T00:01:00.000Z",
        endedAt: "2026-06-17T00:06:00.000Z",
      }),
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents,
      // Ownerless events during the overlap — attribution is ambiguous, so the
      // label is omitted rather than mis-attributed to whichever started later.
      tokenEvents: [
        { tMs: start + 30_000, costUsd: 0.1 },
        { tMs: start + 130_000, costUsd: 0.5 },
      ],
    });

    const subA = items.find(
      (i) => i.type === "subagent" && i.sub === "Explorer"
    );
    const subB = items.find(
      (i) => i.type === "subagent" && i.sub === "Builder"
    );
    if (subA?.type !== "subagent" || subB?.type !== "subagent") {
      throw new Error("expected both subagent turns");
    }
    expect(subA.cost).toBeNull();
    expect(subB.cost).toBeNull();
  });

  it("attributes cost events to each of multiple non-overlapping subagent turns", () => {
    const sub1Start = Date.parse("2026-06-17T00:00:00.000Z");
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-1",
        name: "Explorer",
        type: "subagent",
        subagentType: "Explore",
        status: "completed",
        startedAt: "2026-06-17T00:00:00.000Z",
        endedAt: "2026-06-17T00:00:45.000Z",
      }),
      agent({
        externalAgentId: "sub-2",
        name: "Builder",
        type: "subagent",
        subagentType: "Build",
        status: "completed",
        startedAt: "2026-06-17T00:01:00.000Z",
        endedAt: "2026-06-17T00:02:00.000Z",
      }),
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents,
      tokenEvents: [
        { tMs: sub1Start + 30_000, costUsd: 0.1 },
        { tMs: sub1Start + 90_000, costUsd: 0.2 },
      ],
    });

    const sub1 = items[0]!;
    if (sub1.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    const sub2 = items[1]!;
    if (sub2.type !== "subagent") {
      throw new Error("expected subagent turn");
    }

    expect(sub1.costDelta).toBe(0.1);
    expect(sub2.costDelta).toBe(0.2);
    expect(sub2.cum).toBeCloseTo(0.3, 10);
    // Non-overlapping spans + ownerless events → each trusts its timestamp delta.
    expect(sub1.cost).toBe("$0.10");
    expect(sub2.cost).toBe("$0.20");
    expect(sub1.tokens).toBeNull();
    expect(sub2.tokens).toBeNull();
  });

  it("renders a sub-cent sub-agent cost precisely rather than flooring it to $0.00 (wongk review)", () => {
    const subStart = Date.parse("2026-06-17T00:00:00.000Z");
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-1",
        name: "Explorer",
        type: "subagent",
        subagentType: "Explore",
        status: "completed",
        startedAt: "2026-06-17T00:00:00.000Z",
        endedAt: "2026-06-17T00:01:00.000Z",
      }),
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents,
      // Under $0.005: fixed-2dp would floor this to "$0.00", making a real cost
      // indistinguishable from "no data". The precise formatter shows it instead.
      tokenEvents: [{ tMs: subStart + 10_000, costUsd: 0.004 }],
    });

    const sub = items[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    // costDelta records the real attributed spend...
    expect(sub.costDelta).toBe(0.004);
    // ...and the label shows it precisely (4dp), a distinct state from null.
    expect(sub.cost).toBe("$0.004");
    expect(sub.tokens).toBeNull();
  });

  it("omits a sub-agent's cost label only when no spend is attributed (null, not $0.00)", () => {
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-1",
        name: "Explorer",
        type: "subagent",
        subagentType: "Explore",
        status: "completed",
        startedAt: "2026-06-17T00:00:00.000Z",
        endedAt: "2026-06-17T00:01:00.000Z",
      }),
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents,
      // No cost-bearing events land on this sub-agent → genuinely absent.
      tokenEvents: [],
    });

    const sub = items[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    // No attributed spend is "no data", which stays null — never a lying "$0.00".
    expect(sub.cost).toBeNull();
    expect(sub.tokens).toBeNull();
  });

  it("sets cost to null for a null-externalAgentId subagent when the only owned event has zero cost", () => {
    // Claims ONE branch: labelSubagentCosts' `delta > 0 ? format : null` FALSE
    // arm — every token event is zero-cost so the timestamp delta is 0, and a
    // non-positive delta must NOT render as "$0.00". Inverting that ternary
    // yields "$0.00" and fails the assertion.
    //
    // It deliberately does NOT claim two branches it happens to execute:
    //   - ownedCostByAgent's `if (costUsd === 0) continue`. This subagent's
    //     externalAgentId is null, so the owned map is never consulted for it;
    //     letting the zero-cost event into the map changes nothing here. The
    //     pair below covers that guard where it IS observable.
    //   - labelSubagentCosts' `owner == null ? undefined : get(owner)`. A null
    //     key is a map miss anyway, so the null-check is behaviorally
    //     indistinguishable from omitting it.

    // Force null into the typed string field to exercise the null-owner branch.
    const externalAgentId: string = null as any;
    const agents: SyncedAgentSessionAgent[] = [
      {
        externalAgentId,
        name: "Nulled",
        type: "subagent",
        status: "completed",
        startedAt: "2026-06-17T00:00:00.000Z",
        endedAt: "2026-06-17T00:01:00.000Z",
      },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents,
      // A non-empty tokenEvents array so attributeTokenEventCosts runs fully
      // and calls labelSubagentCosts. The event has agentExternalId so it
      // passes the `!owner` guard in ownedCostByAgent, but costUsd=0 triggers
      // the zero-cost skip before the agent is added to the owned map.
      tokenEvents: [
        {
          tMs: Date.parse("2026-06-17T00:00:30.000Z"),
          costUsd: 0,
          agentExternalId: "other-agent",
        },
      ],
    });

    const sub = items[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    // Null owner → no ownership-metered cost. Lone span (no overlap). Zero delta
    // → cost stays null, not "$0.00".
    expect(sub.cost).toBeNull();
  });

  // The pair below is where `ownedCostByAgent`'s `if (costUsd === 0) continue`
  // IS observable: the subagent's own externalAgentId matches the event, so the
  // owned map is actually consulted for it. Dropping the zero-cost skip would
  // put `sub-zero` in the map with 0 and render "$0.00" instead of null.
  const ownedCostAgents = (): SyncedAgentSessionAgent[] => [
    agent({
      externalAgentId: "sub-zero",
      name: "Zeroed",
      type: "subagent",
      status: "completed",
      startedAt: "2026-06-17T00:00:00.000Z",
      endedAt: "2026-06-17T00:01:00.000Z",
    }),
  ];

  it("leaves cost null when the subagent's OWN only token event is zero-cost", () => {
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents: ownedCostAgents(),
      tokenEvents: [
        {
          tMs: Date.parse("2026-06-17T00:00:30.000Z"),
          costUsd: 0,
          agentExternalId: "sub-zero",
        },
      ],
    });

    const sub = items[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    expect(sub.cost).toBeNull();
  });

  it("renders the owned sum when the subagent's OWN token event carries spend", () => {
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents: ownedCostAgents(),
      tokenEvents: [
        {
          tMs: Date.parse("2026-06-17T00:00:30.000Z"),
          costUsd: 0.25,
          agentExternalId: "sub-zero",
        },
      ],
    });

    const sub = items[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    expect(sub.cost).toBe("$0.25");
  });
});

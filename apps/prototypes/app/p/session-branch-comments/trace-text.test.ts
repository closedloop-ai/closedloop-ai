import { describe, expect, it } from "vitest";
import type { PrComment, SessionLane, TraceTurn } from "./mock";
import { buildSessionComments } from "./mock-comments";
import { countCommentsByTurnId, turnExcerpt } from "./trace-text";

const session = (id: string): SessionLane => ({
  id,
  actorId: "u-alex",
  actor: "Alex Rivera",
  sub: "seed generator",
  color: "var(--chart-1)",
  activeLabel: "5m",
  startPct: 0,
  endPct: 50,
  bursts: [],
});

const humanTurn: TraceTurn = {
  id: "t1",
  userId: "u-alex",
  side: "human",
  timeLabel: "9:14am",
  blocks: [{ type: "p", spans: ["Build the seed generator."] }],
};

const agentTurn: TraceTurn = {
  id: "t2",
  userId: "u-alex",
  side: "agent",
  timeLabel: "9:15am",
  blocks: [
    {
      type: "p",
      spans: [
        "I mapped the ",
        { code: "org" },
        " table and opened ",
        { pr: 42 },
        ".",
      ],
    },
    { type: "tools", summary: "Ran 2 tools", rows: [] },
  ],
};

const comment = (overrides: Partial<PrComment>): PrComment => ({
  id: "c",
  author: "You",
  at: "just now",
  body: "note",
  ...overrides,
});

describe("turnExcerpt", () => {
  it("flattens the first paragraph, including inline code and PR spans", () => {
    expect(turnExcerpt(agentTurn)).toBe(
      "I mapped the org table and opened #42."
    );
  });

  it("falls back to the tool summary when a turn has no prose block", () => {
    expect(
      turnExcerpt({
        ...agentTurn,
        blocks: [{ type: "tools", summary: "Ran 3 tools", rows: [] }],
      })
    ).toBe("Ran 3 tools");
  });
});

describe("countCommentsByTurnId", () => {
  it("tallies anchored comments per turn and ignores anchor-less ones", () => {
    const counts = countCommentsByTurnId([
      comment({ id: "a", anchorTurnId: "t2" }),
      comment({ id: "b", anchorTurnId: "t2" }),
      comment({ id: "c", anchorTurnId: "t1" }),
      comment({ id: "d" }),
    ]);
    expect(counts).toEqual({ t1: 1, t2: 2 });
  });
});

describe("buildSessionComments", () => {
  it("seeds comments anchored to real trace turns with a message excerpt", () => {
    const trace = [humanTurn, agentTurn];
    const comments = buildSessionComments(
      "br_unmapped_branch",
      [session("s1"), session("s2")],
      trace
    );

    expect(comments).toHaveLength(2);
    const turnIds = new Set(trace.map((turn) => turn.id));
    for (const seeded of comments) {
      const anchor = seeded.anchorTurnId;
      expect(anchor).toBeDefined();
      expect(anchor ? turnIds.has(anchor) : false).toBe(true);
      expect((seeded.anchorPreview ?? "").length).toBeGreaterThan(0);
    }
    // The first seeded comment prefers an agent turn so the excerpt reads as work.
    expect(comments[0]?.anchorTurnId).toBe("t2");
  });

  it("returns nothing for a branch flagged as having no session comments", () => {
    expect(
      buildSessionComments("br_dependabot", [session("s1")], [agentTurn])
    ).toEqual([]);
  });
});

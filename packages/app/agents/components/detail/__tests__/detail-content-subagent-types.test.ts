/**
 * ISS-4677: the `buildOverviewStats` subagent-type tally — kept in its own file
 * because `detail-content.test.ts` is at the 1,000-line ceiling.
 *
 * The tally must reconcile with the Subagents metric rendered beside it, and it
 * must never state a confident zero for agent rows that have not arrived.
 */

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { buildSessionDetailContent } from "../detail-content";

/** 3 rows of one type, 2 of a second, then singletons — a deliberate count tie. */
function tiedSubagentType(index: number): string {
  if (index < 3) {
    return "busiest";
  }
  if (index < 5) {
    return "second";
  }
  return `type-${index}`;
}

describe("buildOverviewStats subagent types (ISS-4677)", () => {
  function agent(
    overrides: Partial<AgentSessionDetail["agents"][number]>
  ): AgentSessionDetail["agents"][number] {
    return {
      externalAgentId: "agent-x",
      name: "Agent",
      status: "completed",
      type: "subagent",
      ...overrides,
    };
  }

  const mainAgent = agent({
    externalAgentId: "agent-main",
    name: "Main",
    parentExternalAgentId: null,
    subagentType: null,
    type: "main",
  });

  // ISS-5366 retired `sessions-subagent-transcript-disclosure`, so the builder
  // has no tally switch left: every session takes this shape.
  function overview(session: AgentSessionDetail) {
    return buildSessionDetailContent(session).overview;
  }

  // The bug: the desktop writer inserts a root row (`type='main'`,
  // `subagent_type=NULL`, `parent_agent_id=NULL`). Tallying it under a "main"
  // label made the list disagree with the Subagents metric beside it.
  it("excludes the session's own main agent so the tally reconciles with the Subagents metric", () => {
    const stats = overview(
      createAgentSessionDetailFixture({
        agentCount: 3,
        agents: [
          mainAgent,
          agent({
            externalAgentId: "agent-1",
            parentExternalAgentId: "agent-main",
            subagentType: "review",
          }),
          agent({
            externalAgentId: "agent-2",
            parentExternalAgentId: "agent-main",
            subagentType: "review",
          }),
        ],
      })
    );

    expect(stats.subagentTypes.map((entry) => entry.label)).toEqual(["review"]);
    expect(
      stats.subagentTypes.reduce((total, entry) => total + entry.count, 0)
    ).toBe(stats.subagents);
    expect(stats.subagentTypesOmitted).toBe(0);
  });

  it("renders no subagent types for a loaded session that ran none", () => {
    const stats = overview(
      createAgentSessionDetailFixture({ agentCount: 1, agents: [mainAgent] })
    );

    expect(stats.subagentTypes).toEqual([]);
    expect(stats.subagents).toBe(0);
    // Rows arrived and there are genuinely none — a knowable zero.
    expect(stats.subagentTypesAvailable).toBe(true);
  });

  // The state the panel used to mislabel as "No subagent activity."
  it("marks the tally unavailable when the agent rows have not arrived", () => {
    const stats = overview(
      createAgentSessionDetailFixture({ agentCount: 0, agents: [] })
    );

    expect(stats.subagentTypes).toEqual([]);
    expect(stats.subagentTypesAvailable).toBe(false);
    // ISS-5366 (#4579 stage review): and the METRIC agrees. This used to be
    // `resolveSubagentCount(session) ?? 0`, so one panel rendered a confident
    // "Subagents 0" beside "Subagent types aren't available for this session." —
    // two claims about the same unknown, and a reader believes the number. Both
    // producers set `agentCount = agents.length`, so this fixture is the real
    // not-yet-loaded shape, not a contrived one.
    expect(stats.subagents).toBeNull();
  });

  // The two fields answer ONE question, so they must never disagree — that
  // divergence is the whole defect. Pinned as an invariant rather than as two
  // independent expectations, so a future edit to either derivation trips here.
  it.each([
    ["rows absent", { agentCount: 0, agents: [] }],
    ["main agent only", { agentCount: 1, agents: [mainAgent] }],
    [
      "one subagent",
      {
        agentCount: 2,
        agents: [mainAgent, agent({ subagentType: "reviewer" })],
      },
    ],
  ])("keeps the Subagents count and the types-availability flag consistent (%s)", (_label, overrides) => {
    const stats = overview(createAgentSessionDetailFixture(overrides));

    // A null count and an "unavailable" tally are the same statement; a
    // non-null count and an available tally are the other one.
    expect(stats.subagents === null).toBe(
      stats.subagentTypesAvailable === false
    );
  });

  it("orders types by count desc with a stable tie-break and caps the list", () => {
    const stats = overview(
      createAgentSessionDetailFixture({
        agentCount: 13,
        agents: [
          mainAgent,
          ...Array.from({ length: 12 }, (_unused, index) =>
            agent({
              externalAgentId: `agent-${index}`,
              parentExternalAgentId: "agent-main",
              // One type with 3 rows, one with 2, then ten singletons whose
              // labels must break the tie alphabetically.
              subagentType: tiedSubagentType(index),
            })
          ),
        ],
      })
    );

    expect(stats.subagentTypes).toHaveLength(8);
    expect(stats.subagentTypes.slice(0, 2)).toEqual([
      { count: 3, isCompaction: false, label: "busiest" },
      { count: 2, isCompaction: false, label: "second" },
    ]);
    expect(stats.subagentTypes.slice(2).map((entry) => entry.label)).toEqual([
      "type-10",
      "type-11",
      "type-5",
      "type-6",
      "type-7",
      "type-8",
    ]);
    // The cap truncates, so the visible chips no longer sum to `subagents`.
    // Reporting the remainder is what keeps that a shortlist rather than a
    // contradiction of the metric rendered directly above it.
    const omitted = stats.subagentTypesOmitted ?? 0;
    expect(omitted).toBe(1);
    // ISS-5366: `subagents` is `number | null` — null is "the agent rows never
    // arrived", never zero. This fixture supplies rows, so the reconciliation
    // below is only meaningful once we have asserted a real count to reconcile
    // AGAINST; a nullish bound would make `toBeLessThanOrEqual` vacuous.
    expect(stats.subagents).not.toBeNull();
    expect(
      stats.subagentTypes.reduce((total, entry) => total + entry.count, 0) +
        omitted
    ).toBeLessThanOrEqual(stats.subagents as number);
  });

  // The exclusion must match the writer's ROOT row exactly. An unparented
  // non-main row is still a subagent — `agentCount - 1` counts it — so dropping
  // it from the tally would re-open the reconciliation gap from the other side.
  it("keeps an unparented non-main agent in the tally", () => {
    const stats = overview(
      createAgentSessionDetailFixture({
        agentCount: 2,
        agents: [
          mainAgent,
          agent({
            externalAgentId: "agent-orphan",
            name: "Compact conversation",
            parentExternalAgentId: null,
            subagentType: null,
            type: "compaction",
          }),
        ],
      })
    );

    // Labelled by its OWN type (it used to be filed under "main"), and its
    // compaction tone now follows from that honest label.
    expect(stats.subagentTypes).toEqual([
      { count: 1, isCompaction: true, label: "compaction" },
    ]);
    expect(
      stats.subagentTypes.reduce((total, entry) => total + entry.count, 0)
    ).toBe(stats.subagents);
  });

  // The metric is derived from the agent ROWS, not from a blind `agentCount - 1`.
  // A session whose root row was deleted and not healed has no main agent to
  // subtract, and the blind subtraction reported one fewer subagent than the
  // tally rendered chips for — the two must partition the same population.
  it("derives the Subagents metric from the agent rows, not agentCount - 1", () => {
    const noRootRow = createAgentSessionDetailFixture({
      agentCount: 2,
      agents: [
        agent({
          externalAgentId: "agent-1",
          parentExternalAgentId: "agent-main",
          subagentType: "explorer",
        }),
        agent({
          externalAgentId: "agent-2",
          parentExternalAgentId: "agent-main",
          subagentType: "qa",
        }),
      ],
    });

    const stats = overview(noRootRow);
    expect(stats.subagents).toBe(2);
    expect(
      stats.subagentTypes.reduce((total, entry) => total + entry.count, 0)
    ).toBe(stats.subagents);
  });
});

/**
 * ISS-6890: the agent-type analytics must not zero a whole session's
 * contribution because one persisted roster member is unreadable.
 *
 * A separate file from `analytics-aggregation.test.ts` on purpose: that file is
 * already past the 1,000-line ceiling, and `aggregateByAgentType` is a pure
 * function over `AnalyticsSessionRecord[]`, so this needs neither the DB
 * mock nor the service harness that file carries.
 */

import { describe, expect, it } from "vitest";
import { buildPersistedAgent } from "@/__tests__/support/agent-sessions/service.test-harness";
import { aggregateByAgentType } from "./analytics-aggregation";
import type { AnalyticsSessionRecord } from "./records";

function jsonSession(agents: unknown): AnalyticsSessionRecord {
  return {
    artifactId: "session-1",
    agents,
    events: [],
  } as unknown as AnalyticsSessionRecord;
}

describe("aggregateByAgentType roster integrity (ISS-6890)", () => {
  it("still buckets the readable members of a session whose roster holds one unreadable member", () => {
    // The MIXED roster is the case. An all-valid fixture buckets identically
    // whether the read is per-member or all-or-nothing, so it proves nothing.
    const breakdown = aggregateByAgentType([
      jsonSession([
        buildPersistedAgent({
          externalAgentId: "agent-1",
          subagentType: "reviewer",
          status: "completed",
        }),
        { externalAgentId: "agent-2", name: "" },
        buildPersistedAgent({
          externalAgentId: "agent-3",
          subagentType: "reviewer",
          status: "completed",
        }),
      ]),
    ]);

    // Before the per-member read this whole session collapsed to `[]`, so the
    // `reviewer` bucket read 0 rather than 2 — an org-wide undercount driven by
    // one version-skewed member.
    expect(breakdown.byAgentType).toEqual([
      expect.objectContaining({ agentType: "reviewer", count: 2 }),
    ]);
    // #5209 review: 2 is a LOWER BOUND, and the fold now says so rather than
    // publishing it as the exact population.
    expect(breakdown.integrity.agentRosterIncomplete).toEqual({
      unreadableAgents: 1,
      affectedSessions: 1,
    });
  });

  it("contributes nothing from a session whose roster is entirely unreadable, without dropping its siblings", () => {
    const breakdown = aggregateByAgentType([
      jsonSession([{ externalAgentId: "agent-2", name: "" }]),
      jsonSession([
        buildPersistedAgent({
          externalAgentId: "agent-9",
          subagentType: "planner",
          status: "completed",
        }),
      ]),
    ]);

    expect(breakdown.byAgentType).toEqual([
      expect.objectContaining({ agentType: "planner", count: 1 }),
    ]);
    expect(breakdown.integrity.agentRosterIncomplete).toEqual({
      unreadableAgents: 1,
      affectedSessions: 1,
    });
  });

  it("reports the population UNKNOWN when a session's stored roster is not a readable list", () => {
    // The all-unreadable case at the analytics boundary. A blob that is not an
    // array cannot say how many members it held, so a number here would be
    // invented — `null` is the honest reading, and `affectedSessions` still
    // says the fold came up short.
    const breakdown = aggregateByAgentType([
      jsonSession({ not: "an array" }),
      jsonSession([
        buildPersistedAgent({
          externalAgentId: "agent-9",
          subagentType: "planner",
          status: "completed",
        }),
      ]),
    ]);

    expect(breakdown.byAgentType).toEqual([
      expect.objectContaining({ agentType: "planner", count: 1 }),
    ]);
    expect(breakdown.integrity.agentRosterIncomplete).toEqual({
      unreadableAgents: null,
      affectedSessions: 1,
    });
  });

  it("keeps the population UNKNOWN once one blob is unreadable, however many partial rosters follow", () => {
    // A readable-but-partial session must not turn an unknowable total back
    // into a confident number — `null` absorbs, it never resets.
    const breakdown = aggregateByAgentType([
      jsonSession({ not: "an array" }),
      jsonSession([
        buildPersistedAgent({ externalAgentId: "agent-1" }),
        { externalAgentId: "agent-2", name: "" },
      ]),
    ]);

    expect(breakdown.integrity.agentRosterIncomplete).toEqual({
      unreadableAgents: null,
      affectedSessions: 2,
    });
  });

  it("SUMS the countable losses across sessions rather than reporting only the first", () => {
    // ISS-7062: the case that actually forces the population fold. Every other
    // test here has at most ONE countable session, so a "first incompleteness
    // wins, later ones ignored" fold (`incomplete ?? roster.incomplete`) would
    // produce identical output and stay green — including the absorb test above,
    // where `unreadable_value` coming first makes the two behaviors coincide.
    // Two sessions each losing a DIFFERENT countable number is what separates
    // them. The expected total is written out, not derived from the fold.
    const breakdown = aggregateByAgentType([
      jsonSession([
        buildPersistedAgent({ externalAgentId: "agent-1" }),
        { externalAgentId: "bad-1", name: "" },
      ]),
      jsonSession([
        buildPersistedAgent({ externalAgentId: "agent-2" }),
        { externalAgentId: "bad-2", name: "" },
        { externalAgentId: "bad-3", name: "" },
      ]),
    ]);

    expect(breakdown.integrity.agentRosterIncomplete).toEqual({
      unreadableAgents: 3,
      affectedSessions: 2,
    });
  });

  it("OMITS the incompleteness field entirely when every roster in the population read whole", () => {
    // Absence is the contract's only encoding of "complete" — a present zero
    // (or a `null`) would become a third state every consumer has to interpret,
    // and an older client would read it as a caveat that does not apply.
    const breakdown = aggregateByAgentType([
      jsonSession([
        buildPersistedAgent({
          externalAgentId: "agent-1",
          subagentType: "planner",
          status: "completed",
        }),
      ]),
    ]);

    expect(breakdown.byAgentType).toHaveLength(1);
    expect("agentRosterIncomplete" in breakdown.integrity).toBe(false);
  });
});

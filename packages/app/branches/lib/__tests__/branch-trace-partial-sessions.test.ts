import {
  BranchTraceCompletenessState,
  type BranchTraceResult,
  BranchTraceSessionHydrationState,
  BranchTraceUnavailableReason,
  type MergedTraceItem,
} from "@repo/api/src/types/branch-trace";
import { describe, expect, it } from "vitest";
import {
  branchTraceWithoutPartialSessions,
  branchTraceWithPartialSessions,
  unreadableTraceItemCount,
} from "../branch-trace-partial-sessions";

/*
 * ISS-9723: the producers always serve the partial trace. This module is the
 * closed-by-default gate over it, so each case is asserted in BOTH states from
 * one fixture — the open state must keep what the closed state withholds, or the
 * gate is not gating anything.
 */

describe("Branch trace partial-Session projections (ISS-9723)", () => {
  it("keeps a partial Session's readable items when the gate is open", () => {
    const result = branchTraceWithPartialSessions(mixedResult());

    expect(result?.items.map((item) => item.sessionId)).toEqual([
      "s-partial",
      "s-clean",
    ]);
    expect(result?.sessions.map((session) => session.state)).toEqual([
      BranchTraceSessionHydrationState.Loaded,
      BranchTraceSessionHydrationState.Loaded,
    ]);
  });

  it("withholds a partial Session whole when the gate is closed", () => {
    const result = branchTraceWithoutPartialSessions(mixedResult());

    expect(result?.items.map((item) => item.sessionId)).toEqual(["s-clean"]);
    const withheld = result?.sessions[0];
    expect(withheld?.state).toBe(BranchTraceSessionHydrationState.Unavailable);
    expect(
      withheld?.state === BranchTraceSessionHydrationState.Unavailable
        ? withheld.reason
        : null
    ).toBe(BranchTraceUnavailableReason.Malformed);
    expect(result?.completeness.state).toBe(
      BranchTraceCompletenessState.Incomplete
    );
  });

  it("drops a synthesized idle marker it cannot re-size rather than restating it", () => {
    const withIdle: BranchTraceResult = {
      ...mixedResult(),
      items: [
        traceItem("s-partial", "kept"),
        // Attributed to the RETAINED Session, but the builder sized its gap over
        // a population that included the Session the closed gate withholds.
        {
          type: "idle",
          sessionId: "s-clean",
          t: "2026-06-10T10:00:00.000Z",
          gapMs: 300_000,
        },
        traceItem("s-clean", "clean"),
      ],
    };

    const closed = branchTraceWithoutPartialSessions(withIdle);
    const open = branchTraceWithPartialSessions(withIdle);

    expect(closed?.items.map((item) => item.type)).toEqual(["end"]);
    // The sibling: with the gate open nothing is withheld, so the marker the
    // producer measured is still the truth and survives.
    expect(open?.items.some((item) => item.type === "idle")).toBe(true);
  });

  it("reports a closed gate that withheld every Session as unavailable", () => {
    const onlyPartial: BranchTraceResult = {
      ...mixedResult(),
      items: [traceItem("s-partial", "kept")],
      sessions: [loadedSession("s-partial", 2)],
      qualifyingSessionCount: 1,
    };

    const closed = branchTraceWithoutPartialSessions(onlyPartial);
    const open = branchTraceWithPartialSessions(onlyPartial);

    expect(closed?.items).toEqual([]);
    expect(closed?.aggregateCompleteness.state).toBe(
      BranchTraceCompletenessState.Unavailable
    );
    // The sibling: the same fixture with the gate open keeps the rows and never
    // reports the population unavailable.
    expect(open?.items).toHaveLength(1);
    expect(open?.aggregateCompleteness.state).not.toBe(
      BranchTraceCompletenessState.Unavailable
    );
  });

  it("passes a trace that dropped nothing through unchanged in both states", () => {
    const clean: BranchTraceResult = {
      ...mixedResult(),
      items: [traceItem("s-clean", "kept")],
      sessions: [loadedSession("s-clean")],
      qualifyingSessionCount: 1,
      completeness: { state: BranchTraceCompletenessState.Complete },
      aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
    };

    expect(branchTraceWithoutPartialSessions(clean)).toBe(clean);
    expect(branchTraceWithPartialSessions(clean)).toBe(clean);
  });

  it("has no trace to project before one loads", () => {
    expect(branchTraceWithPartialSessions(null)).toBeNull();
    expect(branchTraceWithoutPartialSessions(undefined)).toBeNull();
  });
});

describe("unreadableTraceItemCount (ISS-9723)", () => {
  it("totals the per-Session counts the producer reported", () => {
    expect(unreadableTraceItemCount(mixedResult())).toBe(3);
  });

  it("is zero for a trace whose Sessions all parsed whole", () => {
    expect(
      unreadableTraceItemCount({
        ...mixedResult(),
        sessions: [loadedSession("s-clean")],
      })
    ).toBe(0);
  });

  it("is zero before a trace loads", () => {
    expect(unreadableTraceItemCount(null)).toBe(0);
  });
});

/** One partial Session and one clean one, as a producer now serves them. */
function mixedResult(): BranchTraceResult {
  return {
    items: [traceItem("s-partial", "kept"), traceItem("s-clean", "clean")],
    sessions: [loadedSession("s-partial", 3), loadedSession("s-clean")],
    qualifyingSessionCount: 2,
    completeness: { state: BranchTraceCompletenessState.Incomplete },
    aggregateCompleteness: { state: BranchTraceCompletenessState.Incomplete },
  };
}

function loadedSession(artifactId: string, unreadableItemCount?: number) {
  return {
    identity: {
      artifactId,
      name: artifactId,
      navigableRef: artifactId,
      slug: artifactId,
    },
    state: BranchTraceSessionHydrationState.Loaded,
    ...(unreadableItemCount === undefined ? {} : { unreadableItemCount }),
  } as const;
}

function traceItem(sessionId: string, text: string): MergedTraceItem {
  return { type: "end", sessionId, text };
}

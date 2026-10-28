import { describe, expect, it } from "vitest";
import { BranchViewerScope } from "../branch.js";
import {
  BranchTraceCompletenessState,
  type BranchTraceSessionHydration,
  BranchTraceSessionHydrationState,
  BranchTraceUnavailableReason,
  type MergedTraceItem,
  normalizeBranchTracePage,
  normalizeBranchTraceResult,
  partitionReadableTraceItems,
  withUnreadableItemCount,
} from "../branch-trace.js";

const traceItem = {
  type: "end" as const,
  sessionId: "session-1",
  text: "done",
};

const identity = {
  artifactId: "session-1",
  name: "Session one",
  slug: "SES-1",
  navigableRef: "SES-1",
  externalSessionId: "external-1",
};

describe("Branch trace contract", () => {
  it("accepts additive page fields and preserves the complete trace state", () => {
    const page = normalizeBranchTracePage({
      branchId: "branch-1",
      viewerScope: BranchViewerScope.Organization,
      items: [traceItem],
      hasMore: false,
      futureField: true,
      traceState: {
        sessions: [
          {
            identity: { ...identity, futureIdentityField: "ignored" },
            state: BranchTraceSessionHydrationState.Loaded,
          },
        ],
        qualifyingSessionCount: 1,
        completeness: { state: BranchTraceCompletenessState.Complete },
        aggregateCompleteness: {
          state: BranchTraceCompletenessState.Complete,
        },
        futureStateField: true,
      },
    });

    expect(page).toMatchObject({
      items: [traceItem],
      traceState: {
        qualifyingSessionCount: 1,
        sessions: [
          {
            identity,
            state: BranchTraceSessionHydrationState.Loaded,
          },
        ],
      },
    });
    expect(page?.metadataReason).toBeUndefined();
  });

  it("strips unknown fields from otherwise-valid current and legacy items", () => {
    const rawItem = {
      ...traceItem,
      rawError: "credential-shaped detail",
    };
    const page = normalizeBranchTracePage({
      branchId: "branch-1",
      viewerScope: BranchViewerScope.Organization,
      items: [rawItem],
      hasMore: false,
      traceState: {
        sessions: [
          { identity, state: BranchTraceSessionHydrationState.Loaded },
        ],
        qualifyingSessionCount: 1,
        completeness: { state: BranchTraceCompletenessState.Complete },
        aggregateCompleteness: {
          state: BranchTraceCompletenessState.Complete,
        },
      },
    });
    const legacy = normalizeBranchTraceResult([rawItem]);

    expect(page?.items).toEqual([traceItem]);
    expect(legacy.items).toEqual([traceItem]);
    expect(JSON.stringify({ page, legacy })).not.toContain(
      "credential-shaped detail"
    );
  });

  it("strips unknown fields nested inside valid tool rows", () => {
    const page = normalizeBranchTracePage({
      branchId: "branch-1",
      viewerScope: BranchViewerScope.Organization,
      items: [
        {
          type: "tools",
          sessionId: identity.artifactId,
          t: "2026-08-01T00:00:00.000Z",
          tMs: 1,
          endMs: 2,
          summary: "tool",
          hasFail: false,
          failN: 0,
          items: [
            {
              label: "read",
              detail: "file",
              err: false,
              rawOutput: "private nested output",
            },
          ],
        },
      ],
      hasMore: false,
      traceState: {
        sessions: [
          { identity, state: BranchTraceSessionHydrationState.Loaded },
        ],
        qualifyingSessionCount: 1,
        completeness: { state: BranchTraceCompletenessState.Complete },
        aggregateCompleteness: {
          state: BranchTraceCompletenessState.Complete,
        },
      },
    });

    expect(JSON.stringify(page)).not.toContain("private nested output");
  });

  it("returns null for a page missing required base fields", () => {
    const page = normalizeBranchTracePage({
      branchId: "branch-1",
      viewerScope: BranchViewerScope.Organization,
      items: [traceItem],
      // hasMore intentionally omitted — fails the base page schema.
    });

    expect(page).toBeNull();
  });

  it("marks a page's metadata malformed when its traceState is invalid", () => {
    const page = normalizeBranchTracePage({
      branchId: "branch-1",
      viewerScope: BranchViewerScope.Organization,
      items: [traceItem],
      hasMore: false,
      traceState: { qualifyingSessionCount: -1 },
    });

    expect(page?.items).toEqual([traceItem]);
    expect(page?.traceState).toBeNull();
    expect(page?.metadataReason).toBe(BranchTraceUnavailableReason.Malformed);
  });

  it("keeps legacy HTTP items but marks membership metadata as legacy", () => {
    const page = normalizeBranchTracePage({
      branchId: "branch-1",
      viewerScope: BranchViewerScope.Organization,
      items: [traceItem],
      hasMore: false,
    });

    expect(page?.items).toEqual([traceItem]);
    expect(page?.traceState).toBeNull();
    expect(page?.metadataReason).toBe(
      BranchTraceUnavailableReason.LegacyResponse
    );
  });

  it("normalizes a legacy Desktop raw array without inferring completeness", () => {
    const result = normalizeBranchTraceResult([traceItem]);

    expect(result.items).toEqual([traceItem]);
    expect(result.qualifyingSessionCount).toBeNull();
    expect(result.completeness).toEqual({
      state: BranchTraceCompletenessState.Unavailable,
      reason: BranchTraceUnavailableReason.LegacyResponse,
    });
  });

  it("retains valid items while malformed metadata fails closed", () => {
    const result = normalizeBranchTraceResult({
      items: [traceItem, { type: "unknown", sessionId: "bad" }],
      sessions: [{ identity, state: "invented" }],
      qualifyingSessionCount: -1,
      completeness: { state: "complete" },
      aggregateCompleteness: { state: "complete" },
      secretError: "do not serialize me",
    });

    expect(result.items).toEqual([traceItem]);
    expect(result.qualifyingSessionCount).toBeNull();
    expect(result.aggregateCompleteness).toEqual({
      state: BranchTraceCompletenessState.Unavailable,
      reason: BranchTraceUnavailableReason.Malformed,
    });
    expect(JSON.stringify(result)).not.toContain("do not serialize me");
  });

  it("rejects a completeness count that does not match retained identities", () => {
    const result = normalizeBranchTraceResult({
      items: [traceItem],
      sessions: [{ identity, state: BranchTraceSessionHydrationState.Loaded }],
      qualifyingSessionCount: 2,
      completeness: { state: BranchTraceCompletenessState.Complete },
      aggregateCompleteness: {
        state: BranchTraceCompletenessState.Complete,
      },
    });

    expect(result.items).toEqual([traceItem]);
    expect(result.qualifyingSessionCount).toBeNull();
    expect(result.completeness.reason).toBe(
      BranchTraceUnavailableReason.Malformed
    );
  });

  it("rejects duplicate identities and complete states with unavailable evidence", () => {
    const duplicate = normalizeBranchTraceResult({
      items: [traceItem],
      sessions: [
        { identity, state: BranchTraceSessionHydrationState.Loaded },
        { identity, state: BranchTraceSessionHydrationState.Loaded },
      ],
      qualifyingSessionCount: 2,
      completeness: { state: BranchTraceCompletenessState.Complete },
      aggregateCompleteness: {
        state: BranchTraceCompletenessState.Complete,
      },
    });
    const contradictory = normalizeBranchTraceResult({
      items: [],
      sessions: [
        {
          identity,
          state: BranchTraceSessionHydrationState.Unavailable,
          reason: BranchTraceUnavailableReason.NotFound,
        },
      ],
      qualifyingSessionCount: 1,
      completeness: { state: BranchTraceCompletenessState.Complete },
      aggregateCompleteness: {
        state: BranchTraceCompletenessState.Complete,
      },
    });

    expect(duplicate.completeness.reason).toBe(
      BranchTraceUnavailableReason.Malformed
    );
    expect(contradictory.aggregateCompleteness.reason).toBe(
      BranchTraceUnavailableReason.Malformed
    );
  });

  it("rejects invalid timestamps and items outside the loaded identity set", () => {
    const invalidTimestamp = normalizeBranchTraceResult({
      items: [
        {
          type: "event",
          sessionId: identity.artifactId,
          t: "not-a-date",
          dot: "g",
          text: "invalid",
        },
      ],
      sessions: [{ identity, state: BranchTraceSessionHydrationState.Loaded }],
      qualifyingSessionCount: 1,
      completeness: { state: BranchTraceCompletenessState.Complete },
      aggregateCompleteness: {
        state: BranchTraceCompletenessState.Complete,
      },
    });
    const foreignItem = normalizeBranchTraceResult({
      items: [{ ...traceItem, sessionId: "session-2" }],
      sessions: [{ identity, state: BranchTraceSessionHydrationState.Loaded }],
      qualifyingSessionCount: 1,
      completeness: { state: BranchTraceCompletenessState.Complete },
      aggregateCompleteness: {
        state: BranchTraceCompletenessState.Complete,
      },
    });

    expect(invalidTimestamp.items).toEqual([]);
    expect(invalidTimestamp.completeness.reason).toBe(
      BranchTraceUnavailableReason.Malformed
    );
    expect(foreignItem.items).toEqual([
      { ...traceItem, sessionId: "session-2" },
    ]);
    expect(foreignItem.completeness.reason).toBe(
      BranchTraceUnavailableReason.Malformed
    );
  });
});

/*
 * ISS-9723: the drop count is PER SESSION, and both producers derive it from
 * this one helper. A count that lands on the wrong Session tells the reader a
 * Session they can see whole lost items, and hides the loss on the Session that
 * actually took it — so the population under test is deliberately more than one
 * partial Session, with counts that differ from each other.
 */
describe("partitionReadableTraceItems (ISS-9723)", () => {
  it("attributes each dropped item to the Session that produced it", () => {
    const partition = partitionReadableTraceItems([
      endItem("session-a", "kept a"),
      unparsableItem("session-a"),
      endItem("session-b", "kept b"),
      unparsableItem("session-b"),
      unparsableItem("session-b"),
      endItem("session-c", "kept c"),
    ]);

    expect(partition.items.map((item) => item.sessionId)).toEqual([
      "session-a",
      "session-b",
      "session-c",
    ]);
    // Distinct nonzero counts: a helper that collapsed every drop onto one
    // Session, or summed them, cannot satisfy all three of these at once.
    expect(partition.unreadableCountBySession.get("session-a")).toBe(1);
    expect(partition.unreadableCountBySession.get("session-b")).toBe(2);
    expect(partition.unreadableCountBySession.has("session-c")).toBe(false);
  });

  it("refuses a served trace that claims Complete while a Session lost items", () => {
    const state = {
      items: [endItem("session-a", "kept a")],
      sessions: [
        {
          identity: { ...identity, artifactId: "session-a" },
          state: BranchTraceSessionHydrationState.Loaded,
          unreadableItemCount: 1,
        },
      ],
      qualifyingSessionCount: 1,
      completeness: { state: BranchTraceCompletenessState.Complete },
      aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
    };

    // The sibling: the same population without a drop IS a legal complete trace,
    // so the refusal above is the new invariant and not a broken fixture.
    const withoutDrop = {
      ...state,
      sessions: [
        {
          identity: { ...identity, artifactId: "session-a" },
          state: BranchTraceSessionHydrationState.Loaded,
        },
      ],
    };

    expect(normalizeBranchTraceResult(state).completeness.state).toBe(
      BranchTraceCompletenessState.Unavailable
    );
    expect(normalizeBranchTraceResult(withoutDrop).completeness.state).toBe(
      BranchTraceCompletenessState.Complete
    );
  });

  it("reports no drops for a trace whose every item parses", () => {
    const partition = partitionReadableTraceItems([
      endItem("session-a", "kept a"),
      endItem("session-b", "kept b"),
    ]);

    expect(partition.items).toHaveLength(2);
    expect(partition.unreadableCountBySession.size).toBe(0);
  });

  /*
   * A refused item can carry a perfectly good `endMs` — it fails on some other
   * field — and that extent already sized the pause after it. The swimlane
   * re-derives its own spans from the retained items and never sees the dropped
   * one, so a surviving marker would have the two disagreeing about one pause on
   * one screen. Withdraw the marker rather than restate a number nothing here
   * can recompute.
   */
  it("withdraws a synthesized idle marker once it has dropped an item", () => {
    const withIdle = [
      endItem("session-a", "kept a"),
      idleItem("session-a"),
      unparsableItem("session-a"),
    ];

    const dropped = partitionReadableTraceItems(withIdle);
    // The sibling: nothing dropped, so the marker is still measured over the
    // population that is actually present and survives.
    const clean = partitionReadableTraceItems(withIdle.slice(0, 2));

    expect(dropped.items.map((item) => item.type)).toEqual(["end"]);
    expect(clean.items.map((item) => item.type)).toEqual(["end", "idle"]);
    // Withdrawing the marker is not itself an unreadable item.
    expect(dropped.unreadableCountBySession.get("session-a")).toBe(1);
  });
});

describe("withUnreadableItemCount (ISS-9723)", () => {
  const counts = new Map([
    ["session-a", 1],
    ["session-b", 2],
  ]);

  it("stamps each loaded Session with its own count and omits an absent one", () => {
    const stamped = ["session-a", "session-b", "session-c"].map((artifactId) =>
      withUnreadableItemCount(loadedSession(artifactId), counts)
    );

    expect(
      stamped.map((session) =>
        session.state === BranchTraceSessionHydrationState.Loaded
          ? session.unreadableItemCount
          : "unavailable"
      )
    ).toEqual([1, 2, undefined]);
  });

  it("leaves an unavailable Session untouched", () => {
    const unavailable = {
      identity: { ...identity, artifactId: "session-a" },
      state: BranchTraceSessionHydrationState.Unavailable,
      reason: BranchTraceUnavailableReason.Malformed,
    } as const;

    expect(withUnreadableItemCount(unavailable, counts)).toEqual(unavailable);
  });
});

function endItem(sessionId: string, text: string): MergedTraceItem {
  return { type: "end", sessionId, text };
}

function idleItem(sessionId: string): MergedTraceItem {
  return {
    type: "idle",
    sessionId,
    t: "2026-08-01T00:00:00.000Z",
    gapMs: 300_000,
  };
}

/**
 * A `tools` item the contract cannot parse. `NaN` is what an absent or
 * unparseable stamp folds to and Zod 4's `z.number()` refuses it, so this is the
 * item the partition must drop — cast because the union forbids constructing it.
 */
function unparsableItem(sessionId: string): MergedTraceItem {
  return {
    type: "tools",
    sessionId,
    t: "2026-08-01T00:00:00.000Z",
    tMs: Date.parse("2026-08-01T00:00:00.000Z"),
    endMs: Number.NaN,
    summary: "read files",
    hasFail: false,
    failN: 0,
  };
}

function loadedSession(artifactId: string): BranchTraceSessionHydration {
  return {
    identity: { ...identity, artifactId },
    state: BranchTraceSessionHydrationState.Loaded,
  };
}

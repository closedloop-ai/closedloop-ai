import { describe, expect, it } from "vitest";
import { BranchViewerScope } from "../branch.js";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  BranchTraceUnavailableReason,
  normalizeBranchTracePage,
  normalizeBranchTraceResult,
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

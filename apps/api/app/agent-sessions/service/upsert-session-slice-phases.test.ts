/**
 * ISS-8619: the PHASE WIRING of `upsertSessionSlice`, pinned against the split
 * that created it.
 *
 * The suites beside this one drive the real service and prove the apply still
 * writes what it wrote; none of them can fail on the two things a phase split
 * actually risks, because both are invisible in a committed row:
 *
 *   • an early exit that stops running the phases but has already paid for the
 *     ones before it — the ISS-8271 invariant is that a held revision reaches NO
 *     lock and NO read, and a hold that took the locks first still produces a
 *     byte-identical no-write result; and
 *   • a tally the orchestrator now folds from TWO phases instead of one scope —
 *     `indexKeyProjections` (detail + links) and `unstorableCounterFields`
 *     (detail + children). Dropping either half still writes correct rows and
 *     still returns a plausible number, which is exactly the shape the root
 *     `AGENTS.md` forbids emitting.
 *
 * Every phase is mocked so what is under test is the ORDER and the FOLD, not any
 * phase's own behaviour. Expected values are literals chosen here, never read
 * back off the module they police.
 */

import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionUpsertTx, UpsertSessionsContext } from "./records";
import {
  emitSessionBranchDetailChanged,
  readSessionBranchIds,
} from "./session-branch-detail-signal";
import { captureCommittedSessionMetadata } from "./session-ingest-metadata-activity";
import { persistSessionSliceChildren } from "./session-slice-children";
import { writeSessionDetail } from "./session-slice-detail-write";
import {
  resolveRevisionAdmission,
  resolveSessionSliceGate,
} from "./session-slice-gating";
import { resolveSessionSliceIdentity } from "./session-slice-identity";
import { persistSessionSliceLinks } from "./session-slice-links";
import type { UpsertSessionSliceResult } from "./session-slice-result";
import { upsertSessionSlice } from "./upsert-session-slice";
import {
  SessionGateHoldReason,
  type SessionHoldReason,
  WireDataRevisionSkipReason,
} from "./wire-data-revision";

const phaseCalls: string[] = [];
const PREVIOUS_BRANCH_IDS = ["previous-branch"];

vi.mock("./session-branch-detail-signal", () => ({
  readSessionBranchIds: vi.fn(() => {
    phaseCalls.push("branch-memberships");
    return Promise.resolve(PREVIOUS_BRANCH_IDS);
  }),
  emitSessionBranchDetailChanged: vi.fn(() => {
    phaseCalls.push("branch-signal");
    return Promise.resolve();
  }),
}));

/**
 * A DISTINGUISHABLE stored row, and the object identity is the assertion: a
 * `null` here would be satisfied by an orchestrator that hardcodes `null` rather
 * than threading what identity resolved (review: bug_hunter_a on #6798). The
 * cases below compare by reference, so reconstructing an equal literal fails too.
 */
const STORED_ROW = {
  artifactId: "stored-artifact-1",
  artifact: { status: "inactive" },
  activitySegmentRowsStripped: true,
};

/** The end the detail phase resolved — the reopen predicate's input downstream. */
const GUARDED_SESSION_ENDED_AT = new Date("2026-01-01T12:00:00.000Z");

vi.mock("./session-slice-identity", () => ({
  resolveSessionSliceIdentity: vi.fn(() => {
    phaseCalls.push("identity");
    return Promise.resolve({
      existing: STORED_ROW,
      externalSessionIdKey: { value: "sess-1", projected: false },
    });
  }),
}));

vi.mock("./session-slice-gating", () => ({
  resolveRevisionAdmission: vi.fn(() => {
    phaseCalls.push("admission");
    return { effectiveDataRevision: 7 };
  }),
  resolveSessionSliceGate: vi.fn(() => {
    phaseCalls.push("gate");
    return {
      gate: {
        effectiveDataRevision: 7,
        freshness: {},
        guardedStatus: "active",
        incomingAwaitingInputSince: null,
        incomingSessionUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
        incomingStatus: "active",
        pendingChunkPatch: {},
        shouldCommitRevision: true,
        // DISTINCT from `shouldUpdateTokenEventCosts` on purpose. Both reach the
        // children handoff as separate parameters, and `shouldReplace` is what
        // decides snapshot-vs-append inside `persistSessionChildren`, so equal
        // values here would let the orchestrator swap one for the other and stay
        // green (review: marisolashgrove on #6830).
        shouldReplace: false,
        shouldUpdateTokenEventCosts: true,
        unmodelledStatus: "running",
      },
    };
  }),
}));

vi.mock("./session-slice-detail-write", () => ({
  writeSessionDetail: vi.fn(() => {
    phaseCalls.push("detail");
    return Promise.resolve({
      metadataSnapshot: null,
      artifactId: "artifact-1",
      droppedContradictorySessionEnd: true,
      guardedSessionEndedAt: GUARDED_SESSION_ENDED_AT,
      indexKeyProjections: 3,
      shouldUpdatePullRequestLinks: true,
      sourceLoopId: null,
      unstorableCounterFields: ["turns"],
    });
  }),
}));

vi.mock("./session-slice-children", () => ({
  persistSessionSliceChildren: vi.fn(() => {
    phaseCalls.push("children");
    return Promise.resolve({ unstorableCounterFields: ["inputTokens"] });
  }),
}));

vi.mock("./session-slice-links", () => ({
  persistSessionSliceLinks: vi.fn(() => {
    phaseCalls.push("links");
    return Promise.resolve({
      indexKeyProjections: 4,
      droppedOverflowUsageBuckets: ["bucket-a"],
      monitoredActivityOutcomeCounts: { resolved: 1 },
      observedRepositoryFullNames: ["acme/widgets"],
      retryRequired: true,
    });
  }),
}));

vi.mock("./session-ingest-metadata-activity", () => ({
  writeSessionArtifactMetadata: vi.fn(() => {
    phaseCalls.push("metadata-lock");
    return Promise.resolve(null);
  }),
  captureCommittedSessionMetadata: vi.fn(() => {
    phaseCalls.push("metadata-receipt");
    return Promise.resolve();
  }),
}));

const CONTEXT = {
  organizationId: "org-1",
  userId: "user-1",
  computeTargetId: "target-1",
} as UpsertSessionsContext;

const TX = {} as AgentSessionUpsertTx;

/**
 * A complete no-write result, so the early-exit cases assert on the OBJECT the
 * phase returned rather than on a partial stand-in the orchestrator could have
 * rebuilt.
 */
function buildNoWriteResult(
  heldRevisionReason: SessionHoldReason
): UpsertSessionSliceResult {
  return {
    persisted: false,
    retryRequired: false,
    monitoredActivityOutcomeCounts: undefined,
    unmodelledStatus: null,
    droppedContradictorySessionEnd: false,
    observedRepositoryFullNames: [],
    indexKeyProjections: 0,
    droppedOverflowUsageBuckets: [],
    unstorableCounterFields: [],
    activityTilingSkipReason: null,
    heldRevisionReason,
  };
}

function buildInput() {
  return {
    context: CONTEXT,
    dataSyncLevel: undefined,
    includeFrustration: false,
    projectResolution: {
      artifactProjectById: new Map<string, string>(),
    },
    rowLevelAck: true,
    session: {
      externalSessionId: "sess-1",
      name: "Session One",
      status: "active",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      agents: [],
      events: [],
      // `estimatedCostUsd` is OMITTED so the normalized array is distinguishable
      // from the raw one: `normalizeTokenUsage` defaults it to 0. An orchestrator
      // that forwarded `session.tokenUsageByModel` instead fails the handoff
      // assertion below, and so does one that hardcodes `[]`.
      tokenUsageByModel: [
        {
          model: "phases-fixture-model",
          inputTokens: 11,
          outputTokens: 22,
          cacheReadTokens: 33,
          cacheWriteTokens: 44,
        },
      ],
    } as unknown as SyncedAgentSession,
    slugMap: new Map<string, string>(),
    syncTimestamp: new Date("2026-01-02T00:00:00.000Z"),
  };
}

describe("upsertSessionSlice phase wiring (ISS-8619)", () => {
  beforeEach(() => {
    phaseCalls.length = 0;
    vi.clearAllMocks();
  });

  it("runs every phase exactly once, in the order the apply depends on", async () => {
    await upsertSessionSlice(TX, buildInput());

    expect(phaseCalls).toEqual([
      "admission",
      "identity",
      "gate",
      "detail",
      "children",
      "metadata-receipt",
      "branch-memberships",
      "links",
      "branch-signal",
    ]);
  });

  it("folds BOTH halves of each tally the split now spreads across phases", async () => {
    const result = await upsertSessionSlice(TX, buildInput());

    // 3 from the detail upsert's own columns + 4 from component usage.
    expect(result.indexKeyProjections).toBe(7);
    expect(result.unstorableCounterFields).toEqual(["turns", "inputTokens"]);
    expect(result.droppedOverflowUsageBuckets).toEqual(["bucket-a"]);
    expect(result.observedRepositoryFullNames).toEqual(["acme/widgets"]);
    expect(result.droppedContradictorySessionEnd).toBe(true);
    expect(result.retryRequired).toBe(true);
    expect(result.unmodelledStatus).toBe("running");
    expect(result.persisted).toBe(true);
    expect(result.heldRevisionReason).toBeNull();
  });

  it("hands each phase the identity and gate the phase before it produced", async () => {
    await upsertSessionSlice(TX, buildInput());

    expect(resolveSessionSliceGate).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveDataRevision: 7,
        existing: STORED_ROW,
      })
    );
    expect(writeSessionDetail).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        gate: expect.objectContaining({ shouldReplace: false }),
      })
    );
    expect(captureCommittedSessionMetadata).toHaveBeenCalledWith(
      TX,
      CONTEXT.organizationId,
      null,
      "artifact-1"
    );
    expect(persistSessionSliceLinks).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        artifactId: "artifact-1",
        shouldUpdatePullRequestLinks: true,
      })
    );

    expect(readSessionBranchIds).toHaveBeenCalledExactlyOnceWith(
      TX,
      CONTEXT.organizationId,
      "artifact-1"
    );
    expect(emitSessionBranchDetailChanged).toHaveBeenCalledExactlyOnceWith(
      TX,
      CONTEXT.organizationId,
      "artifact-1",
      PREVIOUS_BRANCH_IDS
    );
    expect(vi.mocked(emitSessionBranchDetailChanged).mock.calls[0][3]).toBe(
      PREVIOUS_BRANCH_IDS
    );

    // By REFERENCE, not shape. The stored row reaches the detail write and the
    // children phase because identity resolved it — an orchestrator that passed
    // `null`, or rebuilt an equal literal, fails here.
    expect(
      vi.mocked(writeSessionDetail).mock.calls[0][1].identity.existing
    ).toBe(STORED_ROW);
    const childrenInput = vi.mocked(persistSessionSliceChildren).mock
      .calls[0][1];
    expect(childrenInput.existing).toBe(STORED_ROW);
    expect(childrenInput.artifactId).toBe("artifact-1");
    expect(childrenInput.shouldUpdateTokenEventCosts).toBe(true);
    expect(childrenInput.shouldReplace).toBe(false);
    // The NORMALIZED array, resolved once by the orchestrator — not the raw
    // payload rows and not an empty stand-in.
    expect(childrenInput.normalizedTokenUsage).toEqual([
      {
        model: "phases-fixture-model",
        inputTokens: 11,
        outputTokens: 22,
        cacheReadTokens: 33,
        cacheWriteTokens: 44,
        estimatedCostUsd: 0,
      },
    ]);
    // The reopen predicate's end comes from the DETAIL phase's resolution, not
    // from the payload — dropping the handoff would silently stop reopening
    // terminal rows.
    expect(childrenInput.guardedSessionEndedAt).toBe(GUARDED_SESSION_ENDED_AT);
  });

  it("ISS-8271: a held revision reaches NO lock and NO stored-row read", async () => {
    const held = buildNoWriteResult(WireDataRevisionSkipReason.RevisionPending);
    vi.mocked(resolveRevisionAdmission).mockReturnValueOnce({ held });

    const result = await upsertSessionSlice(TX, buildInput());

    expect(result).toBe(held);
    expect(phaseCalls).toEqual([]);
    expect(resolveSessionSliceIdentity).not.toHaveBeenCalled();
    expect(resolveSessionSliceGate).not.toHaveBeenCalled();
    expect(writeSessionDetail).not.toHaveBeenCalled();
    expect(readSessionBranchIds).not.toHaveBeenCalled();
    expect(emitSessionBranchDetailChanged).not.toHaveBeenCalled();
  });

  it("a gate refusal stops before the first write, but AFTER identity ran", async () => {
    const refusal = buildNoWriteResult(SessionGateHoldReason.ForeignChunk);
    vi.mocked(resolveSessionSliceGate).mockImplementationOnce(() => {
      phaseCalls.push("gate");
      return { refusal };
    });

    const result = await upsertSessionSlice(TX, buildInput());

    expect(result).toBe(refusal);
    expect(phaseCalls).toEqual(["admission", "identity", "gate"]);
    expect(writeSessionDetail).not.toHaveBeenCalled();
    expect(readSessionBranchIds).not.toHaveBeenCalled();
    expect(emitSessionBranchDetailChanged).not.toHaveBeenCalled();
    expect(persistSessionSliceChildren).not.toHaveBeenCalled();
    expect(persistSessionSliceLinks).not.toHaveBeenCalled();
  });
});

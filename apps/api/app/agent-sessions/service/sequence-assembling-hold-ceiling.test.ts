/**
 * ISS-11427: the ceiling on the ISS-8131 `sequence_assembling` hold, driven
 * through the real `resolveSessionSliceGate` and the real chunk gate, so a hold
 * that never expires — or one that expires by letting the staged sequence seal
 * a union — fails here.
 */
import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ emitTelemetryMetric: vi.fn() }));
vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

import { PendingChunkAckContract } from "./pending-chunk-ack-contract";
import { SEQUENCE_ASSEMBLING_HOLD_CEILING_MS } from "./sequence-assembling-hold-ceiling";
import { resolveSessionSliceGate } from "./session-slice-gating";
import type { SessionSliceIdentity } from "./session-slice-identity";
import { SessionSyncMetric } from "./session-sync-metrics";
import { SessionGateHoldReason } from "./wire-data-revision";

const LAST_CHUNK_AT = new Date("2026-10-05T10:00:00.000Z");
const MINUTE_MS = 60 * 1000;

/** An instant `offsetMs` after the staged sequence's last write. */
function at(offsetMs: number): Date {
  return new Date(LAST_CHUNK_AT.getTime() + offsetMs);
}

type StoredRow = NonNullable<SessionSliceIdentity["existing"]>;

function storedRow(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    artifactId: "artifact-held",
    agents: [],
    monitoredActivityHeldSince: null,
    dataRevision: 3,
    pendingChunkRevision: 4,
    pendingChunkTotal: 3,
    pendingChunkReceived: 1,
    lastSyncedAt: LAST_CHUNK_AT,
    pendingChunkAckContract: PendingChunkAckContract.RowLevel,
    dataRevisionDiverged: null,
    sessionStartedAt: new Date("2026-10-05T09:00:00.000Z"),
    sessionUpdatedAt: new Date("2026-10-05T09:30:00.000Z"),
    sessionEndedAt: null,
    activitySegmentRowsStripped: false,
    awaitingInputSince: null,
    authoritativeCostUsd: null,
    estimatedCost: null,
    pullRequests: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    artifact: { status: "active" },
    ...overrides,
  } as StoredRow;
}

const REVISIONLESS_SESSION = {
  externalSessionId: "sess-held",
  name: "Held session",
  status: "active",
  startedAt: "2026-10-05T09:00:00.000Z",
  updatedAt: "2026-10-05T09:45:00.000Z",
  agents: [],
  events: [],
  tokenUsageByModel: [],
} as unknown as SyncedAgentSession;

function gateAt(syncTimestamp: Date, existing: StoredRow, rowLevelAck = true) {
  return resolveSessionSliceGate({
    computeTargetId: "target-1",
    effectiveDataRevision: undefined,
    existing,
    organizationId: "org-1",
    rowLevelAck,
    session: REVISIONLESS_SESSION,
    syncTimestamp,
  });
}

beforeEach(() => {
  mocks.emitTelemetryMetric.mockReset();
});

const HELD = SessionGateHoldReason.SequenceAssembling;

describe("resolveSessionSliceGate — sequence_assembling hold ceiling", () => {
  it("holds inside the ceiling, measured from the staged sequence's last write", () => {
    const outcome = gateAt(
      at(SEQUENCE_ASSEMBLING_HOLD_CEILING_MS - MINUTE_MS),
      storedRow()
    );

    expect(outcome.refusal?.heldRevisionReason).toBe(HELD);
    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.SequenceAssemblingHoldExpired,
      })
    );
  });

  it("at the ceiling frees all four marker columns and applies the payload additively", () => {
    const outcome = gateAt(
      at(SEQUENCE_ASSEMBLING_HOLD_CEILING_MS),
      storedRow()
    );

    expect(outcome.refusal).toBeUndefined();
    expect(outcome.gate?.pendingChunkPatch).toEqual({
      pendingChunkRevision: null,
      pendingChunkTotal: null,
      pendingChunkReceived: null,
      pendingChunkAckContract: null,
      dataRevisionDiverged: true,
    });
    // The ISS-8131 hazard was the staged sequence SEALING a union. Nothing
    // commits a revision here and nothing replaces the children.
    expect(outcome.gate?.shouldCommitRevision).toBe(false);
    expect(outcome.gate?.shouldReplace).toBe(false);
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith({
      metric: SessionSyncMetric.SequenceAssemblingHoldExpired,
      organizationId: "org-1",
      computeTargetId: "target-1",
      count: 1,
    });
  });

  it("never frees a sequence that is still receiving chunks, whatever else holds the session", () => {
    const outcome = gateAt(
      at(MINUTE_MS),
      storedRow({
        monitoredActivityHeldSince: new Date(
          LAST_CHUNK_AT.getTime() - 3 * SEQUENCE_ASSEMBLING_HOLD_CEILING_MS
        ),
      })
    );

    expect(outcome.refusal?.heldRevisionReason).toBe(HELD);
  });

  it("never frees a marker whose producer did not ask for the row-level ack", () => {
    for (const band of [PendingChunkAckContract.WholeBatch, null]) {
      const outcome = gateAt(
        at(SEQUENCE_ASSEMBLING_HOLD_CEILING_MS * 10),
        storedRow({ pendingChunkAckContract: band })
      );

      expect(outcome.refusal?.heldRevisionReason).toBe(HELD);
    }
  });

  it("leaves a batch that cannot express a hold on its additive path, freeing nothing", () => {
    const outcome = gateAt(
      at(SEQUENCE_ASSEMBLING_HOLD_CEILING_MS * 10),
      storedRow(),
      false
    );

    expect(outcome.refusal).toBeUndefined();
    expect(outcome.gate?.pendingChunkPatch).not.toHaveProperty(
      "pendingChunkRevision"
    );
    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.SequenceAssemblingHoldExpired,
      })
    );
  });
});

/**
 * ISS-11427 review (whitlockk): a sequence staged AT the committed revision — an
 * ISS-6167 re-send, which stages without replacing — is the case where freeing
 * it let the extra events survive. The next chunk 0 at that revision also
 * staged without replacing, so the final chunk committed the union. Driven
 * through the expiry, the restart and the final chunk, applying each patch to
 * the stored row as the write phase does.
 */
describe("resolveSessionSliceGate — after the ceiling frees a re-sent revision", () => {
  function gateRevision(
    existing: StoredRow,
    chunk: { index: number; total: number } | null,
    syncTimestamp: Date
  ) {
    return resolveSessionSliceGate({
      computeTargetId: "target-1",
      effectiveDataRevision: 3,
      existing,
      organizationId: "org-1",
      rowLevelAck: true,
      session: { ...REVISIONLESS_SESSION, dataRevision: 3, chunk },
      syncTimestamp,
    });
  }

  function applied(row: StoredRow, patch: object | undefined): StoredRow {
    return { ...row, ...patch } as StoredRow;
  }

  const RESENT_AT_COMMITTED = { pendingChunkRevision: 3, pendingChunkTotal: 2 };

  it("replaces the children on the restart and commits only that revision", () => {
    const expired = gateAt(
      at(SEQUENCE_ASSEMBLING_HOLD_CEILING_MS),
      storedRow(RESENT_AT_COMMITTED)
    );
    let row = applied(
      storedRow(RESENT_AT_COMMITTED),
      expired.gate?.pendingChunkPatch
    );
    expect(row.dataRevisionDiverged).toBe(true);

    const restart = gateRevision(
      row,
      { index: 0, total: 2 },
      at(SEQUENCE_ASSEMBLING_HOLD_CEILING_MS + MINUTE_MS)
    );
    expect(restart.gate?.shouldReplace).toBe(true);
    expect(restart.gate?.pendingChunkPatch).toMatchObject({
      pendingChunkRevision: 3,
      dataRevisionDiverged: false,
    });
    row = applied(row, restart.gate?.pendingChunkPatch);

    const finalChunk = gateRevision(
      row,
      { index: 1, total: 2 },
      at(SEQUENCE_ASSEMBLING_HOLD_CEILING_MS + 2 * MINUTE_MS)
    );
    expect(finalChunk.gate?.shouldReplace).toBe(false);
    expect(finalChunk.gate?.shouldCommitRevision).toBe(true);
  });

  it("replaces on an unchunked payload at that revision too", () => {
    const outcome = gateRevision(
      storedRow({ ...FREED, dataRevisionDiverged: true }),
      null,
      at(SEQUENCE_ASSEMBLING_HOLD_CEILING_MS + MINUTE_MS)
    );

    expect(outcome.gate?.shouldReplace).toBe(true);
    expect(outcome.gate?.pendingChunkPatch.dataRevisionDiverged).toBe(false);
  });

  it("keeps ISS-6167's no-delete re-open while the children are the revision's", () => {
    const outcome = gateRevision(
      storedRow({ ...FREED, dataRevisionDiverged: false }),
      { index: 0, total: 2 },
      at(SEQUENCE_ASSEMBLING_HOLD_CEILING_MS + MINUTE_MS)
    );

    expect(outcome.gate?.shouldReplace).toBe(false);
    expect(outcome.gate?.pendingChunkPatch).toMatchObject({
      pendingChunkRevision: 3,
    });
  });
});

const FREED = {
  pendingChunkRevision: null,
  pendingChunkTotal: null,
  pendingChunkReceived: null,
  pendingChunkAckContract: null,
};

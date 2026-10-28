/**
 * ISS-8602: the producer band staged beside a chunk-sequence marker.
 *
 * The band values are written as LITERALS here, never imported from the module
 * under test. The sweep's predicate and the desktop's ack contract both key off
 * these exact strings, so a suite that read them from the const object would
 * follow a rename straight past the compatibility break it exists to catch.
 *
 * The two wiring describes matter most, and neither is a resolver test, because
 * there are TWO writers of these columns and the resolver being correct says
 * nothing about either reaching the row.
 *
 * "the gate's staged marker" drives the real `resolveSessionSliceGate`. That
 * wiring is a SPREAD, so dropping it leaves the marker writing and the band
 * permanently NULL — which compiles clean, since the field is optional, so only
 * an assertion through the gate can fail on it.
 *
 * "the ISS-8604 create arm" drives the second writer, which NAMES its columns
 * instead of spreading and can stage a marker the shared gate refused. It was
 * missed on the first pass and the band came out NULL there (review: review-soul).
 */

import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: vi.fn(),
}));

import { resolvePendingChunkAckContractPatch } from "./pending-chunk-ack-contract";
import { resolveSessionSliceGate } from "./session-slice-gating";
import { resolveCreateArmChunkColumns } from "./upsert-arm-detail";

const ROW_LEVEL = "row_level";
const WHOLE_BATCH = "whole_batch";

const STAGING_PATCH = {
  pendingChunkRevision: 5,
  pendingChunkTotal: 3,
  pendingChunkReceived: 1,
} as const;

describe("resolvePendingChunkAckContractPatch", () => {
  it("stamps the row-level band when the producer asked for the echo", () => {
    expect(resolvePendingChunkAckContractPatch(STAGING_PATCH, true)).toEqual({
      pendingChunkAckContract: ROW_LEVEL,
    });
  });

  it("stamps the whole-batch band when it did not", () => {
    // The band the sweep must never clear. A resolver that hardcoded the
    // row-level spelling would pass the case above and fail this one.
    expect(resolvePendingChunkAckContractPatch(STAGING_PATCH, false)).toEqual({
      pendingChunkAckContract: WHOLE_BATCH,
    });
  });

  it("clears the band with the marker a committing apply clears", () => {
    const committing = {
      pendingChunkRevision: null,
      pendingChunkTotal: null,
      pendingChunkReceived: null,
    };

    // Both bands, because the clear must not depend on who is sending: a
    // committed sequence has no producer band to keep.
    expect(resolvePendingChunkAckContractPatch(committing, true)).toEqual({
      pendingChunkAckContract: null,
    });
    expect(resolvePendingChunkAckContractPatch(committing, false)).toEqual({
      pendingChunkAckContract: null,
    });
  });

  it("leaves the band alone for an interior chunk that only advances the count", () => {
    // The band belongs to the producer that OPENED the sequence — the one whose
    // outbox holds the tail — so an interior chunk must not restamp it. An empty
    // patch is the only way to say "untouched": an explicit value here would let
    // a mid-sequence batch from a different band overwrite chunk 0's record.
    expect(
      resolvePendingChunkAckContractPatch({ pendingChunkReceived: 2 }, false)
    ).toEqual({});
    expect(
      resolvePendingChunkAckContractPatch({ pendingChunkReceived: 2 }, true)
    ).toEqual({});
  });

  it("leaves the band alone for a foreign payload that writes no marker at all", () => {
    expect(resolvePendingChunkAckContractPatch({}, true)).toEqual({});
  });
});

describe("the gate's staged marker", () => {
  it("carries the producer band chunk 0 arrived on", () => {
    const rowLevel = resolveGate({ rowLevelAck: true });
    const wholeBatch = resolveGate({ rowLevelAck: false });

    // Through the production entry point, not the resolver: this is what reds if
    // the `...resolvePendingChunkAckContractPatch(...)` spread is dropped from
    // the gate's return. The marker below would still be staged, so only the
    // band assertion catches it.
    expect(rowLevel.gate?.pendingChunkPatch).toEqual({
      ...STAGING_PATCH,
      pendingChunkAckContract: ROW_LEVEL,
    });
    // The two bands asserted in one case so a gate that threads a constant
    // instead of the batch's own `rowLevelAck` cannot pass.
    expect(wholeBatch.gate?.pendingChunkPatch).toEqual({
      ...STAGING_PATCH,
      pendingChunkAckContract: WHOLE_BATCH,
    });
  });
});

describe("the ISS-8604 create arm", () => {
  it("names the band on a marker the shared gate refused", () => {
    // THE GAP THIS CLOSES (review: review-soul). The create arm re-runs the gate
    // with every stored field forced absent, so a payload the shared gate called
    // FOREIGN — a stale chunk 0, below the stored high-water mark — is advancing
    // here and stages a marker. The shared gate's patch is empty for it, so an
    // arm that inherited the band instead of naming it would land a staged marker
    // with a NULL band: declined by the sweep forever, for a reason that has
    // nothing to do with its producer, and counted as if it were a legacy client.
    const columns = resolveCreateArmChunkColumns({
      incomingRevision: STAGING_PATCH.pendingChunkRevision,
      rowLevelAck: true,
      session: buildChunkZeroSession(),
    });

    expect(columns.pendingChunkRevision).toBe(
      STAGING_PATCH.pendingChunkRevision
    );
    expect(columns.pendingChunkAckContract).toBe(ROW_LEVEL);
  });

  it("names the other band from the same arm", () => {
    // Both bands from one arm, so a constant cannot pass.
    const columns = resolveCreateArmChunkColumns({
      incomingRevision: STAGING_PATCH.pendingChunkRevision,
      rowLevelAck: false,
      session: buildChunkZeroSession(),
    });

    expect(columns.pendingChunkAckContract).toBe(WHOLE_BATCH);
  });

  it("names a NULL band when it stages no marker at all", () => {
    // An unchunked payload commits rather than stages, so all four are NULL —
    // and the band must be NAMED null rather than omitted, or the shared
    // `detailData`'s value would survive the override.
    const columns = resolveCreateArmChunkColumns({
      incomingRevision: STAGING_PATCH.pendingChunkRevision,
      rowLevelAck: true,
      session: { ...buildChunkZeroSession(), chunk: undefined },
    });

    expect(columns.pendingChunkRevision).toBeNull();
    expect(columns.pendingChunkAckContract).toBeNull();
  });
});

function resolveGate(params: { rowLevelAck: boolean }) {
  return resolveSessionSliceGate({
    computeTargetId: "target-1",
    effectiveDataRevision: STAGING_PATCH.pendingChunkRevision,
    existing: null,
    organizationId: "org-1",
    rowLevelAck: params.rowLevelAck,
    session: buildChunkZeroSession(),
    syncTimestamp: new Date("2026-07-10T12:00:00.000Z"),
  });
}

function buildChunkZeroSession(): SyncedAgentSession {
  return {
    externalSessionId: "sess-1",
    status: "active",
    harness: "claude",
    startedAt: "2026-07-10T10:00:00.000Z",
    updatedAt: "2026-07-10T11:00:00.000Z",
    dataRevision: STAGING_PATCH.pendingChunkRevision,
    chunk: { index: 0, total: STAGING_PATCH.pendingChunkTotal },
    agents: [],
    events: [],
    tokenUsageByModel: [],
  } as SyncedAgentSession;
}

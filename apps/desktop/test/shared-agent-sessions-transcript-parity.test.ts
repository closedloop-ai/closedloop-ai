/**
 * @file shared-agent-sessions-transcript-parity.test.ts
 * @description ISS-4647 item 6: the desktop LOCAL Sessions producer must derive
 * `cloudSyncState` from BOTH cloud lanes — the metadata outbox AND the
 * raw-transcript blob — so it agrees with the cloud list for the same session.
 * Before this, the local list read `pendingOutboxIds` alone, so once metadata was
 * acked a session whose transcript was still queued/uploading reported `synced`
 * with no pending disclosure at all.
 *
 * Lives in its own file (not `shared-agent-sessions-api.test.ts`) because that
 * suite is a grandfathered over-ceiling file that must not grow.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  buildLocalCloudSyncDisclosure,
  buildLocalTranscriptDispositions,
  deriveLocalTranscriptDisposition,
} from "../src/main/session/local-transcript-cloud-sync.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import {
  redactedArchiveCursorTargetId,
  type TranscriptMainBlobState,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import { TranscriptSyncStatus } from "../src/shared/transcript-sync-status-contract.js";

const TARGET = "target-123";

function blobState(
  overrides: Partial<TranscriptMainBlobState> = {}
): TranscriptMainBlobState {
  return {
    externalSessionId: "session-a",
    status: TranscriptSyncStatus.Queued,
    syncedByteOffset: 0,
    syncedComputeTargetId: null,
    cloudUploadedAt: null,
    cloudUploadedComputeTargetId: null,
    ...overrides,
  };
}

function session(id: string): SyncedAgentSession {
  return {
    externalSessionId: id,
    name: `Session ${id}`,
    status: "completed",
    harness: "claude",
    billingMode: "api",
    cwd: `/tmp/${id}`,
    model: "gpt-test",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T01:00:00.000Z",
    endedAt: "2026-01-01T02:00:00.000Z",
    awaitingInputSince: null,
    metadata: { kind: "fixture" },
    attribution: {
      repositoryFullName: null,
      worktreePath: null,
      sourceArtifactId: null,
      sourceLoopId: null,
      baseBranch: null,
    },
    agents: [],
    events: [],
    tokenUsageByModel: [],
  };
}

/** The narrowest source the local list path needs, plus the outbox delegate. */
function fakeSource(
  ids: string[],
  pendingOutboxIds: string[] = [],
  rejectOutbox?: Error
): AgentSessionSyncSource {
  const rows = ids.map((id) => ({
    id,
    updated_at: "2026-01-01T00:00:00.000Z",
  }));
  return {
    listAllSessionCursorRows: () => rows,
    listSessionCursorPage: (request: { offset: number; limit: number }) => ({
      rows: rows.slice(request.offset, request.offset + request.limit),
      total: rows.length,
    }),
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: (loadIds: readonly string[]) =>
      loadIds.map((id) => session(id)),
    loadPendingOutboxIds: () =>
      rejectOutbox ? Promise.reject(rejectOutbox) : pendingOutboxIds,
  } as unknown as AgentSessionSyncSource;
}

async function listWithBlobStates(
  states: TranscriptMainBlobState[],
  options: {
    ids?: string[];
    pendingOutboxIds?: string[];
    computeTargetId?: string | null;
    reject?: Error;
    rejectOutbox?: Error;
  } = {}
) {
  const ids = options.ids ?? ["session-a"];
  const response = await getSharedAgentSessions(
    fakeSource(ids, options.pendingOutboxIds ?? [], options.rejectOutbox),
    { quality: "all" },
    {
      computeTargetId:
        options.computeTargetId === undefined
          ? TARGET
          : options.computeTargetId,
      loadTranscriptBlobStates: () => {
        if (options.reject) {
          return Promise.reject(options.reject);
        }
        return Promise.resolve(states);
      },
    }
  );
  return new Map(response.items.map((item) => [item.id, item]));
}

test("ISS-4647: a queued transcript blob makes the local row `pending` even though metadata is acked", async () => {
  const byId = await listWithBlobStates([
    blobState({ status: TranscriptSyncStatus.Queued }),
  ]);

  const row = byId.get("session-a");
  assert.equal(row?.cloudSyncState, AgentSessionCloudSyncState.Pending);
  assert.equal(row?.transcriptDisposition, TranscriptDisposition.Syncing);
});

test("ISS-4647: a transcript blob current for THIS target keeps the local row `synced`", async () => {
  const byId = await listWithBlobStates([
    blobState({
      status: TranscriptSyncStatus.Idle,
      syncedByteOffset: 500,
      syncedComputeTargetId: redactedArchiveCursorTargetId(TARGET),
    }),
  ]);

  const row = byId.get("session-a");
  assert.equal(row?.cloudSyncState, AgentSessionCloudSyncState.Synced);
  assert.equal(row?.transcriptDisposition, TranscriptDisposition.Synced);
});

test("ISS-4647: a TERMINALLY skipped transcript blob is settled, so the local row is `synced`", async () => {
  const byId = await listWithBlobStates([
    blobState({ status: TranscriptSyncStatus.Dead }),
  ]);

  const row = byId.get("session-a");
  assert.equal(row?.cloudSyncState, AgentSessionCloudSyncState.Synced);
  assert.equal(
    row?.transcriptDisposition,
    TranscriptDisposition.FailedPermanent
  );
});

test("ISS-4647: a session with no transcript row keeps the outbox-only verdict (never a fabricated pending)", async () => {
  const byId = await listWithBlobStates([]);

  const row = byId.get("session-a");
  assert.equal(row?.cloudSyncState, AgentSessionCloudSyncState.Synced);
  assert.equal(row?.transcriptDisposition, undefined);
});

test("ISS-4647: an outbox-pending row stays `pending` and publishes NO transcript verdict", async () => {
  // The whole session is not in the cloud yet, so the blob verdict is subsumed —
  // publishing it would let the badge narrow the message to "just the transcript".
  const byId = await listWithBlobStates(
    [blobState({ status: TranscriptSyncStatus.Queued })],
    { pendingOutboxIds: ["session-a"] }
  );

  const row = byId.get("session-a");
  assert.equal(row?.cloudSyncState, AgentSessionCloudSyncState.Pending);
  assert.equal(row?.transcriptDisposition, undefined);
});

test("#4150: a FAILED transcript lookup publishes NO disclosure (unknown, not `synced`)", async () => {
  // shafty023 review: a lookup that threw is not proof the blob is caught up.
  // The outbox is proven absent here (metadata acked), but the blob lane is
  // unknown, so the aggregate cannot be truthfully `synced` — omit the whole
  // disclosure rather than stamping the false `synced` ISS-4647 set out to kill.
  const byId = await listWithBlobStates([], {
    reject: new Error("db-host busy"),
  });

  const row = byId.get("session-a");
  assert.equal(row?.cloudSyncState, undefined);
  assert.equal(row?.transcriptDisposition, undefined);
});

test("#4150: a FAILED outbox lookup publishes NO disclosure even if the blob read succeeds", async () => {
  // shafty023 review: an outbox read that threw returns an empty set the same as
  // a proven-absent one, so `.has(id)` would misread the metadata lane as acked
  // and publish transcript-scoped copy claiming the row is already in the cloud
  // while its metadata may still be local-only. The failed outbox lane is
  // preserved as unknown, so the whole row's disclosure is omitted.
  const byId = await listWithBlobStates(
    [
      blobState({
        status: TranscriptSyncStatus.Idle,
        syncedByteOffset: 500,
        syncedComputeTargetId: redactedArchiveCursorTargetId(TARGET),
      }),
    ],
    { rejectOutbox: new Error("outbox db-host busy") }
  );

  const row = byId.get("session-a");
  assert.equal(row?.cloudSyncState, undefined);
  assert.equal(row?.transcriptDisposition, undefined);
});

test("#4150: a failing outbox read still renders EVERY row, each with no disclosure", async () => {
  // Companion to the single-row case above: the failure must degrade the
  // per-row verdict only. The old PRD-536 #3449 behavior defaulted such a row
  // to `synced` — a lie about a read that never completed — and the list itself
  // must still come back whole (no throw, no truncation).
  const byId = await listWithBlobStates([], {
    ids: ["session-a", "session-b"],
    rejectOutbox: new Error("outbox read failed"),
  });

  assert.equal(byId.size, 2);
  for (const row of byId.values()) {
    assert.equal(row.cloudSyncState, undefined);
  }
});

test("ISS-4647: bytes uploaded under a PREVIOUS compute target are not current for this one", () => {
  const state = blobState({
    status: TranscriptSyncStatus.Idle,
    syncedByteOffset: 500,
    syncedComputeTargetId: redactedArchiveCursorTargetId("target-old"),
  });

  assert.equal(
    deriveLocalTranscriptDisposition(state, TARGET),
    TranscriptDisposition.Syncing
  );
  assert.equal(
    deriveLocalTranscriptDisposition(state, "target-old"),
    TranscriptDisposition.Synced
  );
});

// wongk (#4253): the durable cloud acknowledgement has to reach this projection,
// or the disclosure and the stranded recovery tell different stories — recovery
// leaves the row settled while the list shows "still syncing" forever, because a
// missing-source row the cloud already holds sits idle at a ZERO cursor.
test("ISS-4815: a cloud acknowledgement from THIS target reads synced at a zero cursor", () => {
  assert.equal(
    deriveLocalTranscriptDisposition(
      blobState({
        status: TranscriptSyncStatus.Idle,
        syncedByteOffset: 0,
        cloudUploadedAt: "2026-08-02T12:00:00.000Z",
        cloudUploadedComputeTargetId: TARGET,
      }),
      TARGET
    ),
    TranscriptDisposition.Synced
  );
});

test("ISS-4815: an acknowledgement from a PREVIOUS target is still syncing here", () => {
  assert.equal(
    deriveLocalTranscriptDisposition(
      blobState({
        status: TranscriptSyncStatus.Idle,
        syncedByteOffset: 0,
        cloudUploadedAt: "2026-08-02T12:00:00.000Z",
        cloudUploadedComputeTargetId: "target-old",
      }),
      TARGET
    ),
    TranscriptDisposition.Syncing
  );
});

// The recovery deliberately RE-ARMS an unattributable acknowledgement, so the
// disclosure must not claim the file is already there — the two sides have to
// agree, and this is the side that stays conservative.
test("ISS-4815: an UNATTRIBUTABLE acknowledgement does not read as synced", () => {
  assert.equal(
    deriveLocalTranscriptDisposition(
      blobState({
        status: TranscriptSyncStatus.Idle,
        syncedByteOffset: 0,
        cloudUploadedAt: "2026-08-02T12:00:00.000Z",
        cloudUploadedComputeTargetId: null,
      }),
      TARGET
    ),
    TranscriptDisposition.Syncing
  );
});

test("ISS-4647: a failed upload attempt is transient, not terminal", () => {
  assert.equal(
    deriveLocalTranscriptDisposition(
      blobState({ status: TranscriptSyncStatus.Failed }),
      TARGET
    ),
    TranscriptDisposition.FailedTransient
  );
});

test("ISS-4647: offline (no compute target) publishes NO transcript verdict at all", async () => {
  // With no target no cursor can be proven current, so EVERY row would fall
  // through to `syncing` and the whole list would claim "transcript still
  // uploading" for transcripts uploaded long ago. The lookup is skipped instead
  // — the same rule the pending-outbox lane already follows.
  const byId = await listWithBlobStates(
    [
      blobState({
        status: TranscriptSyncStatus.Idle,
        syncedByteOffset: 500,
        syncedComputeTargetId: redactedArchiveCursorTargetId(TARGET),
      }),
    ],
    { computeTargetId: null }
  );

  const row = byId.get("session-a");
  assert.equal(row?.cloudSyncState, AgentSessionCloudSyncState.Synced);
  assert.equal(row?.transcriptDisposition, undefined);
});

test("ISS-4647: the fold keys verdicts by externalSessionId", () => {
  const byId = buildLocalTranscriptDispositions(
    [
      blobState({ externalSessionId: "a", status: TranscriptSyncStatus.Dead }),
      blobState({
        externalSessionId: "b",
        status: TranscriptSyncStatus.Uploading,
      }),
    ],
    TARGET
  );

  assert.equal(byId.get("a"), TranscriptDisposition.FailedPermanent);
  assert.equal(byId.get("b"), TranscriptDisposition.Syncing);
  assert.equal(byId.get("c"), undefined);
});

test("ISS-4647: the disclosure fold gives the outbox lane precedence", () => {
  // A row still in the outbox is not in the cloud AT ALL, so it stays `pending`
  // and publishes no blob verdict — otherwise the badge could narrow the message
  // to "just the transcript" while the whole row is missing.
  assert.deepEqual(
    buildLocalCloudSyncDisclosure(
      { known: true, pending: true },
      { available: true, disposition: TranscriptDisposition.Synced }
    ),
    { cloudSyncState: AgentSessionCloudSyncState.Pending }
  );
  assert.deepEqual(
    buildLocalCloudSyncDisclosure(
      { known: true, pending: false },
      { available: true, disposition: TranscriptDisposition.Syncing }
    ),
    {
      cloudSyncState: AgentSessionCloudSyncState.Pending,
      transcriptDisposition: TranscriptDisposition.Syncing,
    }
  );
  assert.deepEqual(
    buildLocalCloudSyncDisclosure(
      { known: true, pending: false },
      { available: true, disposition: undefined }
    ),
    { cloudSyncState: AgentSessionCloudSyncState.Synced }
  );
});

test("#4150: an UNAVAILABLE lane omits the disclosure instead of defaulting `synced`", () => {
  // shafty023 review: a failed lookup is preserved as unknown. Neither an
  // unavailable outbox lane nor an unavailable transcript lane may publish a
  // verdict — the caller must not be able to read the omission as `synced`.
  assert.deepEqual(
    buildLocalCloudSyncDisclosure(
      { known: false },
      { available: true, disposition: TranscriptDisposition.Synced }
    ),
    {}
  );
  assert.deepEqual(
    buildLocalCloudSyncDisclosure(
      { known: true, pending: false },
      { available: false }
    ),
    {}
  );
  // A KNOWN-pending outbox still wins even when the transcript lane is
  // unavailable — the metadata lane alone proves the row is behind.
  assert.deepEqual(
    buildLocalCloudSyncDisclosure(
      { known: true, pending: true },
      { available: false }
    ),
    { cloudSyncState: AgentSessionCloudSyncState.Pending }
  );
});

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
import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { test } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import { applyLocalSessionTranscriptProjection } from "../src/main/session/local-session-list-projection.js";
import {
  buildLocalCloudSyncDisclosure,
  buildLocalTranscriptVerdicts,
  deriveLocalTranscriptVerdict,
} from "../src/main/session/local-transcript-cloud-sync.js";
import { getSharedAgentSessionDetail } from "../src/main/session/shared-agent-session-detail-read.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import {
  DB_HOST_REPLY_REJECTED_CATEGORY,
  resetDbHostReplyRejectionThrottle,
} from "../src/main/telemetry/db-host-reply-rejection.js";
import { Observability } from "../src/main/telemetry/observability.js";
import type { TelemetryEventPayload } from "../src/main/telemetry/telemetry-protocol.js";
import { DbHostRejectedReplyOp } from "../src/main/telemetry/telemetry-protocol.js";
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
    terminalSkipReason: null,
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

/**
 * The narrowest source the local list path needs, plus the outbox delegate.
 *
 * ISS-8135: `outboxReply` answers a value the STATIC type forbids. That is the
 * point of the fixture, not a shortcut around it — this delegate is a
 * structured-cloned db-host IPC reply, so its declared `string[]` is exactly what
 * stops being true at that boundary.
 */
function fakeSource(
  ids: string[],
  pendingOutboxIds: string[] = [],
  rejectOutbox?: Error,
  outboxReply?: { value: unknown }
): AgentSessionSyncSource {
  const rows = ids.map((id) => ({
    id,
    updated_at: "2026-01-01T00:00:00.000Z",
  }));
  const loadPendingOutboxIds = (): unknown => {
    if (rejectOutbox) {
      return Promise.reject(rejectOutbox);
    }
    return outboxReply ? outboxReply.value : pendingOutboxIds;
  };
  return {
    listAllSessionCursorRows: () => rows,
    listSessionCursorPage: (request: { offset: number; limit: number }) => ({
      rows: rows.slice(request.offset, request.offset + request.limit),
      total: rows.length,
    }),
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: (loadIds: readonly string[]) =>
      loadIds.map((id) => session(id)),
    loadPendingOutboxIds,
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
    outboxReply?: { value: unknown };
  } = {}
) {
  const ids = options.ids ?? ["session-a"];
  const response = await getSharedAgentSessions(
    fakeSource(
      ids,
      options.pendingOutboxIds ?? [],
      options.rejectOutbox,
      options.outboxReply
    ),
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

test("DB-host transcript enrichment cannot turn an unknown metadata lane into synced", async () => {
  const base = await getSharedAgentSessions(
    fakeSource(["session-a"], [], new Error("outbox unavailable")),
    { quality: "all" },
    { computeTargetId: TARGET }
  );

  const projected = await applyLocalSessionTranscriptProjection(
    { ...base, pendingOutboxAvailable: false },
    TARGET,
    () =>
      Promise.resolve([
        blobState({
          status: TranscriptSyncStatus.Idle,
          syncedByteOffset: 10,
          syncedComputeTargetId: TARGET,
        }),
      ])
  );

  assert.equal(projected.items[0]?.cloudSyncState, undefined);
  assert.equal(projected.items[0]?.transcriptDisposition, undefined);
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
  // davetho review: a lookup that threw is not proof the blob is caught up.
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
  // davetho review: an outbox read that threw returns an empty set the same as
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

test("ISS-8135: an UNREADABLE outbox reply publishes no disclosure and is COUNTED", async () => {
  // davetho review (#6041): this list read consumes the SAME structured-cloned
  // db-host reply the sync lane's resume read does, and it used to consume it
  // RAW. `null` threw on `.length` and was swallowed as an ordinary unavailable
  // lookup — no `desktop.db_host.reply_rejected` event, so the covered op had a
  // production bypass — while `"abc"` and `[1, 2]` never threw at all: they went
  // straight into `new Set(...)`, and `.has(id)` then answered off a set of
  // characters or numbers.
  const sink: TelemetryEventPayload[] = [];
  const original = Observability.getTelemetryEmitter;
  Observability.getTelemetryEmitter = () => ({
    emit: (event: TelemetryEventPayload) => {
      sink.push(event);
    },
  });
  try {
    for (const value of [null, "abc", [1, 2], { ids: ["session-a"] }]) {
      sink.length = 0;
      // Each shape is a separate fault; the monitored emit is throttled per op,
      // so without a fresh window only the first would be reported.
      resetDbHostReplyRejectionThrottle();
      const byId = await listWithBlobStates([], {
        outboxReply: { value },
      });

      const row = byId.get("session-a");
      assert.equal(
        row?.cloudSyncState,
        undefined,
        `expected ${JSON.stringify(value)} to publish NO verdict`
      );
      assert.deepEqual(
        sink
          .filter((event) => event.category === DB_HOST_REPLY_REJECTED_CATEGORY)
          .map((event) => event.diagnostics?.dbHostReplyRejected?.op),
        [DbHostRejectedReplyOp.LoadPendingOutboxIds],
        `expected ${JSON.stringify(value)} to reach the monitored path`
      );
    }

    // The positive sibling, on the same subject and through the same fixture
    // door: a READABLE reply must still disclose, and must not be counted.
    sink.length = 0;
    const byId = await listWithBlobStates([], {
      outboxReply: { value: ["session-a"] },
    });
    assert.equal(
      byId.get("session-a")?.cloudSyncState,
      AgentSessionCloudSyncState.Pending
    );
    assert.deepEqual(
      sink.filter(
        (event) => event.category === DB_HOST_REPLY_REJECTED_CATEGORY
      ),
      []
    );
  } finally {
    Observability.getTelemetryEmitter = original;
  }
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
    deriveLocalTranscriptVerdict(state, TARGET).disposition,
    TranscriptDisposition.Syncing
  );
  assert.equal(
    deriveLocalTranscriptVerdict(state, "target-old").disposition,
    TranscriptDisposition.Synced
  );
});

// whitlockk (#4253): the durable cloud acknowledgement has to reach this projection,
// or the disclosure and the stranded recovery tell different stories — recovery
// leaves the row settled while the list shows "still syncing" forever, because a
// missing-source row the cloud already holds sits idle at a ZERO cursor.
test("ISS-4815: a cloud acknowledgement from THIS target reads synced at a zero cursor", () => {
  assert.equal(
    deriveLocalTranscriptVerdict(
      blobState({
        status: TranscriptSyncStatus.Idle,
        syncedByteOffset: 0,
        cloudUploadedAt: "2026-08-02T12:00:00.000Z",
        cloudUploadedComputeTargetId: TARGET,
      }),
      TARGET
    ).disposition,
    TranscriptDisposition.Synced
  );
});

test("ISS-4815: an acknowledgement from a PREVIOUS target is still syncing here", () => {
  assert.equal(
    deriveLocalTranscriptVerdict(
      blobState({
        status: TranscriptSyncStatus.Idle,
        syncedByteOffset: 0,
        cloudUploadedAt: "2026-08-02T12:00:00.000Z",
        cloudUploadedComputeTargetId: "target-old",
      }),
      TARGET
    ).disposition,
    TranscriptDisposition.Syncing
  );
});

// The recovery deliberately RE-ARMS an unattributable acknowledgement, so the
// disclosure must not claim the file is already there — the two sides have to
// agree, and this is the side that stays conservative.
test("ISS-4815: an UNATTRIBUTABLE acknowledgement does not read as synced", () => {
  assert.equal(
    deriveLocalTranscriptVerdict(
      blobState({
        status: TranscriptSyncStatus.Idle,
        syncedByteOffset: 0,
        cloudUploadedAt: "2026-08-02T12:00:00.000Z",
        cloudUploadedComputeTargetId: null,
      }),
      TARGET
    ).disposition,
    TranscriptDisposition.Syncing
  );
});

test("ISS-4647: a failed upload attempt is transient, not terminal", () => {
  assert.equal(
    deriveLocalTranscriptVerdict(
      blobState({ status: TranscriptSyncStatus.Failed }),
      TARGET
    ).disposition,
    TranscriptDisposition.FailedTransient
  );
});

test("ISS-4647: offline (no compute target) publishes NO transcript verdict at all", async () => {
  // With no target no cursor can be proven current, so EVERY row would fall
  // through to `syncing` and the whole list would claim "transcript still
  // uploading" for transcripts uploaded long ago. The lookup is skipped instead.
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
  // ISS-9004 changed the EXPECTATION on this line, not the mechanics: this
  // assertion used to read `AgentSessionCloudSyncState.Synced`. A null target
  // means the outbox was never keyed, so nothing established that the metadata
  // lane is caught up, and the aggregate now publishes no claim at all. The
  // transcript half of this test's subject is untouched.
  assert.equal(row?.cloudSyncState, undefined);
  assert.equal(row?.transcriptDisposition, undefined);
});

/**
 * ISS-9004: the three states the disclosure must keep apart, driven through the
 * one production list read so neither direction of the collapse can hide.
 *
 * UNKNOWN (no compute target) is the state that had no representation of its own
 * — it borrowed proven-empty's, so a row still sitting in the outbox published
 * `synced`, a claim about durability made off a read that never ran. It is
 * resolved toward "say nothing": the same omission #4150 already defined for a
 * lookup that failed, because these are the same fact.
 *
 * The two measured states are asserted beside it deliberately. A fix that simply
 * stopped publishing `synced` would satisfy the first assertion and be just as
 * wrong — an install that IS caught up must still say so.
 */
test("ISS-9004: unknown, measured-empty, and non-empty are three different answers", async () => {
  const queuedFixture = [
    blobState({
      status: TranscriptSyncStatus.Idle,
      syncedByteOffset: 500,
      syncedComputeTargetId: redactedArchiveCursorTargetId(TARGET),
    }),
  ];

  // UNKNOWN: no target, so the outbox is never consulted. The row is queued in
  // it (the non-empty case below proves the fixture is), and the list must not
  // convert "I could not find out" into "there is nothing pending".
  const unknown = await listWithBlobStates(queuedFixture, {
    computeTargetId: null,
    pendingOutboxIds: ["session-a"],
  });
  assert.equal(
    unknown.get("session-a")?.cloudSyncState,
    undefined,
    "a null compute target must publish no cloud-sync claim"
  );

  // MEASURED-EMPTY: the outbox was read under a real target and this row is not
  // in it. `synced` is earned here, and the fix must not have taken it away.
  const measuredEmpty = await listWithBlobStates(queuedFixture, {
    pendingOutboxIds: [],
  });
  assert.equal(
    measuredEmpty.get("session-a")?.cloudSyncState,
    AgentSessionCloudSyncState.Synced,
    "a proven-empty pending set must still read `synced`"
  );

  // NON-EMPTY: same fixture, same target, and the row IS in the outbox.
  const nonEmpty = await listWithBlobStates(queuedFixture, {
    pendingOutboxIds: ["session-a"],
  });
  assert.equal(
    nonEmpty.get("session-a")?.cloudSyncState,
    AgentSessionCloudSyncState.Pending,
    "a row still in the outbox must read `pending`"
  );
});

test("ISS-4647: the fold keys verdicts by externalSessionId", () => {
  const byId = buildLocalTranscriptVerdicts(
    [
      blobState({ externalSessionId: "a", status: TranscriptSyncStatus.Dead }),
      blobState({
        externalSessionId: "b",
        status: TranscriptSyncStatus.Uploading,
      }),
    ],
    TARGET
  );

  assert.equal(
    byId.get("a")?.disposition,
    TranscriptDisposition.FailedPermanent
  );
  assert.equal(byId.get("b")?.disposition, TranscriptDisposition.Syncing);
  assert.equal(byId.get("c"), undefined);
});

test("ISS-4647: the disclosure fold gives the outbox lane precedence", () => {
  // A row still in the outbox is not in the cloud AT ALL, so it stays `pending`
  // and publishes no blob verdict — otherwise the badge could narrow the message
  // to "just the transcript" while the whole row is missing.
  assert.deepEqual(
    buildLocalCloudSyncDisclosure(
      { known: true, pending: true },
      {
        available: true,
        verdict: { disposition: TranscriptDisposition.Synced, reason: null },
      }
    ),
    { cloudSyncState: AgentSessionCloudSyncState.Pending }
  );
  assert.deepEqual(
    buildLocalCloudSyncDisclosure(
      { known: true, pending: false },
      {
        available: true,
        verdict: { disposition: TranscriptDisposition.Syncing, reason: null },
      }
    ),
    {
      cloudSyncState: AgentSessionCloudSyncState.Pending,
      transcriptDisposition: TranscriptDisposition.Syncing,
    }
  );
  assert.deepEqual(
    buildLocalCloudSyncDisclosure(
      { known: true, pending: false },
      { available: true, verdict: undefined }
    ),
    { cloudSyncState: AgentSessionCloudSyncState.Synced }
  );
});

test("#4150: an UNAVAILABLE lane omits the disclosure instead of defaulting `synced`", () => {
  // davetho review: a failed lookup is preserved as unknown. Neither an
  // unavailable outbox lane nor an unavailable transcript lane may publish a
  // verdict — the caller must not be able to read the omission as `synced`.
  assert.deepEqual(
    buildLocalCloudSyncDisclosure(
      { known: false },
      {
        available: true,
        verdict: { disposition: TranscriptDisposition.Synced, reason: null },
      }
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

// ISS-9884 (PLN-1986 §7 item 3) — the desktop's own list must not contradict
// the cloud's about the same transcript. Before migration 0090 it structurally
// could not agree: a `dead` row kept no durable evidence of WHY it died (the
// settle nulls `laneStalledSince` at exactly that moment, and `lastError` is an
// unparseable client message), so every terminal mapped to `failedPermanent`.
// The bucket-unset case — the DEFAULT local-developer path, where `skip`
// answers 200 while `plan`/`complete` 503 — is precisely the one that reaches
// `dead` through an ACKED skip, which is how this is driven.
test("ISS-9884: a dead row acked as environment_unavailable is NOT permanently failed locally", () => {
  const verdict = deriveLocalTranscriptVerdict(
    blobState({
      status: TranscriptSyncStatus.Dead,
      terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
    }),
    TARGET
  );

  assert.deepEqual(verdict, {
    disposition: TranscriptDisposition.FailedTransient,
    reason: TranscriptSkipReason.EnvironmentUnavailable,
  });
});

test("ISS-9884: a dead row acked as too_large is STILL permanently failed", () => {
  // The control. A hard terminal must keep reading hard, or the fix would have
  // traded one lie for another.
  assert.deepEqual(
    deriveLocalTranscriptVerdict(
      blobState({
        status: TranscriptSyncStatus.Dead,
        terminalSkipReason: TranscriptSkipReason.TooLarge,
      }),
      TARGET
    ),
    {
      disposition: TranscriptDisposition.FailedPermanent,
      reason: TranscriptSkipReason.TooLarge,
    }
  );
});

test("ISS-9884: a dead row with NO recorded reason keeps the conservative verdict", () => {
  // Every row that died before migration 0090, and any label a newer build
  // wrote that this one cannot narrow. Must never LIE as recoverable.
  assert.deepEqual(
    deriveLocalTranscriptVerdict(
      blobState({
        status: TranscriptSyncStatus.Dead,
        terminalSkipReason: null,
      }),
      TARGET
    ),
    {
      disposition: TranscriptDisposition.FailedPermanent,
      reason: null,
    }
  );
});

test("ISS-9884: a row on the retry LADDER publishes no reason", () => {
  // `failed` is the ordinary re-queued-with-backoff producer of
  // `failedTransient`. It shares the verdict with a give-up and must not share
  // the copy, which is exactly what the absent reason buys. The row is handed a
  // terminal reason it must NOT publish: every write path clears the column
  // when a row leaves terminal, so a null fixture would leave this assertion
  // satisfied by the input rather than by the branch.
  assert.deepEqual(
    deriveLocalTranscriptVerdict(
      blobState({
        status: TranscriptSyncStatus.Failed,
        terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
      }),
      TARGET
    ),
    { disposition: TranscriptDisposition.FailedTransient, reason: null }
  );
});

test("ISS-9884: the disclosure publishes the reason beside the verdict", () => {
  // The seam that actually reaches the renderer: without this the desktop list
  // would hold the right verdict and still render "Sync failed, retrying".
  assert.deepEqual(
    buildLocalCloudSyncDisclosure(
      { known: true, pending: false },
      {
        available: true,
        verdict: {
          disposition: TranscriptDisposition.FailedTransient,
          reason: TranscriptSkipReason.EnvironmentUnavailable,
        },
      }
    ),
    {
      cloudSyncState: AgentSessionCloudSyncState.Pending,
      transcriptDisposition: TranscriptDisposition.FailedTransient,
      transcriptDispositionReason: TranscriptSkipReason.EnvironmentUnavailable,
    }
  );
});

test("ISS-9884: the reason key is OMITTED, never null, when there is none", () => {
  // Cross-repo rule: an absent optional wire field stays absent. A `null` here
  // would reach a receiving contract that does not declare the field nullable.
  const disclosure = buildLocalCloudSyncDisclosure(
    { known: true, pending: false },
    {
      available: true,
      verdict: {
        disposition: TranscriptDisposition.FailedTransient,
        reason: null,
      },
    }
  );

  assert.equal("transcriptDispositionReason" in disclosure, false);
});

// ISS-9884 — the desktop DETAIL, not just the list. The detail read folded its
// list item with no transcript lookup at all, so the Sync row beside the
// transcript panel carried no disposition and could never say "Upload paused"
// for a transcript the lane gave up on.
async function detailWithBlobState(state: TranscriptMainBlobState) {
  return await getSharedAgentSessionDetail(
    fakeSource(["session-a"]),
    "session-a",
    {
      computeTargetId: TARGET,
      loadTranscriptBlobStates: () => Promise.resolve([state]),
    }
  );
}

test("ISS-9884: the desktop detail carries the paused verdict PAIR the list does", async () => {
  const detail = await detailWithBlobState(
    blobState({
      status: TranscriptSyncStatus.Dead,
      terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
    })
  );

  assert.equal(
    detail?.transcriptDisposition,
    TranscriptDisposition.FailedTransient
  );
  assert.equal(
    detail?.transcriptDispositionReason,
    TranscriptSkipReason.EnvironmentUnavailable
  );
});

test("ISS-9884: a retrying row's detail carries the same disposition and NO reason", async () => {
  // The control. Without it the case above would also pass for a detail that
  // stamped the give-up reason on every `failedTransient`.
  const detail = await detailWithBlobState(
    blobState({ status: TranscriptSyncStatus.Failed })
  );

  assert.ok(detail);
  assert.equal(
    detail.transcriptDisposition,
    TranscriptDisposition.FailedTransient
  );
  assert.equal("transcriptDispositionReason" in detail, false);
});

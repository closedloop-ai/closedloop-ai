import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/session-monitored-activity";
import type {
  AgentSessionSyncBatch,
  SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import { resolvePendingChunkTransition } from "../src/main/agent-sync/agent-session-sync-pending-chunks.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import {
  AGENT_SESSION_SYNC_SOURCE_KIND,
  buildAgentSessionSyncSourceKey,
  type SyncedSessionLoadOptions,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { settleSelfContinuedDrain } from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const TARGET = "target-iss-6060";
const SESSION_ID = "session-iss-6060";
const UPDATED_AT = "2026-08-12T12:10:00.000Z";
// ISS-6479: the RETIRED revision, spelled out because no constant may name it
// again — an install that drained this cursor is exactly the one whose commit
// refs the re-tiering has to reach.
const DRAINED_V1_SOURCE_KEY = `${AGENT_SESSION_SYNC_SOURCE_KIND}:monitored_activity_v1:${TARGET}`;

const activityRef = {
  kind: ArtifactRefTargetKind.Branch,
  repositoryFullName: "closedloop-ai/symphony-alpha",
  branchName: "feat/iss-6060",
  method: ArtifactRefMethod.McpToolCall,
  relation: ArtifactRefRelation.Created,
  monitoredSessionActivity: {
    completeness: BranchActivityEvidenceCompleteness.Complete,
    events: [
      {
        kind: MonitoredSessionActivityEventKind.AgentAction,
        sourceEventId: "monitored_session_v1:stable-event",
        occurredAt: "2026-08-12T12:05:00.000Z",
        completeness: BranchActivityEvidenceCompleteness.Complete,
      },
    ],
  },
} satisfies SyncedArtifactRef;

class CapabilityProjectingSource extends FakeSyncSource {
  readonly projectedCapability: boolean[] = [];
  afterProjection: (() => void) | undefined;

  override loadSyncedSessions(
    ids: string[],
    _cache?: unknown,
    options?: SyncedSessionLoadOptions
  ): SyncedAgentSession[] {
    const include = options?.includeMonitoredSessionActivity === true;
    this.projectedCapability.push(include);
    const projected = super.loadSyncedSessions(ids).map((session) => ({
      ...session,
      artifactRefs: session.artifactRefs?.map((ref) =>
        include ? ref : withoutMonitoredActivity(ref)
      ),
    }));
    this.afterProjection?.();
    return projected;
  }
}

function withoutMonitoredActivity(ref: SyncedArtifactRef): SyncedArtifactRef {
  if (!("monitoredSessionActivity" in ref)) {
    return ref;
  }
  const { monitoredSessionActivity: _removed, ...legacy } = ref;
  return legacy;
}

test("ISS-6060: old-cloud ack followed by upgraded-cloud replay converges exactly once", async () => {
  const source = new CapabilityProjectingSource([
    {
      ...makeSyncedSession(SESSION_ID, UPDATED_AT),
      artifactRefs: [activityRef],
    },
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  let capability = false;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => TARGET,
    isSyncMonitoredActivitySupported: () => capability,
    sendBatch: (batch) => {
      sent.push(batch);
      return Promise.resolve({ accepted: true });
    },
  });

  try {
    service.start();
    await settleSelfContinuedDrain(service);
    assert.equal(sent.length, 1);
    assert.equal(
      Object.hasOwn(
        sent[0].sessions[0].artifactRefs?.[0] ?? {},
        "monitoredSessionActivity"
      ),
      false,
      "legacy cloud receives the ordinary session without the new carrier"
    );

    capability = true;
    await refreshAndSettle(service);
    assert.equal(
      sent.length,
      2,
      "fresh revision cursor replays retained history"
    );
    const replayedRef = sent[1].sessions[0].artifactRefs?.[0];
    assert.ok(replayedRef?.kind === ArtifactRefTargetKind.Branch);
    assert.deepEqual(
      replayedRef.monitoredSessionActivity,
      activityRef.monitoredSessionActivity
    );

    await refreshAndSettle(service);
    capability = false;
    await refreshAndSettle(service);
    capability = true;
    await refreshAndSettle(service);
    assert.equal(
      sent.length,
      2,
      "persisted legacy and revision cursors prevent repeat walks"
    );

    assert.ok(
      source.advanceCalls.some(
        (call) => call.sourceKey === buildAgentSessionSyncSourceKey(TARGET)
      )
    );
    assert.ok(
      source.advanceCalls.some(
        (call) =>
          call.sourceKey === buildAgentSessionSyncSourceKey(TARGET, true)
      )
    );
    assert.deepEqual(source.projectedCapability, [false, true]);
  } finally {
    service.stop();
  }
});

test("ISS-6060: a prepared carrier tail is discarded on capability downgrade", () => {
  const transition = resolvePendingChunkTransition(
    {
      sessionId: SESSION_ID,
      syncMode: AgentSessionSyncMode.Backfill,
      chunks: [
        {
          ...makeSyncedSession(SESSION_ID, UPDATED_AT),
          artifactRefs: [activityRef],
        },
      ],
      compress: false,
      activityChunked: false,
      monitoredActivityIncluded: true,
    },
    true,
    true,
    false
  );

  assert.deepEqual(transition, {
    kind: "discard-downgrade",
    sessionId: SESSION_ID,
    chunkCount: 1,
  });
});

test("ISS-6060: a capability upgrade during hydration reprojects before sending", async () => {
  const source = new CapabilityProjectingSource([
    {
      ...makeSyncedSession(SESSION_ID, UPDATED_AT),
      artifactRefs: [activityRef],
    },
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  let capability = false;
  source.afterProjection = () => {
    source.afterProjection = undefined;
    capability = true;
  };
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => TARGET,
    isSyncMonitoredActivitySupported: () => capability,
    sendBatch: (batch) => {
      sent.push(batch);
      return Promise.resolve({ accepted: true });
    },
  });

  try {
    service.start();
    await service.whenSessionSyncSettled();

    assert.deepEqual(source.projectedCapability, [false]);
    assert.equal(
      sent.length,
      0,
      "the projection built under the stale capability never reaches the wire"
    );
    await refreshAndSettle(service);

    assert.deepEqual(
      source.projectedCapability,
      [false, true],
      "the mismatched first projection is discarded and rehydrated"
    );
    assert.equal(sent.length, 1);
    const sentRef = sent[0].sessions[0].artifactRefs?.[0];
    assert.ok(sentRef?.kind === ArtifactRefTargetKind.Branch);
    assert.deepEqual(
      sentRef.monitoredSessionActivity,
      activityRef.monitoredSessionActivity,
      "only the stable capability projection reaches the wire"
    );
  } finally {
    service.stop();
  }
});

test("ISS-6479: a cursor drained under monitored_activity_v1 replays under the current revision", async () => {
  const drainedUnderRetired = await drainWithSeededCursor(
    DRAINED_V1_SOURCE_KEY
  );
  const drainedUnderCurrent = await drainWithSeededCursor(
    buildAgentSessionSyncSourceKey(TARGET, true)
  );

  assert.equal(
    drainedUnderCurrent.sent.length,
    0,
    "the seeded watermark genuinely suppresses a re-walk under its own key"
  );
  assert.equal(
    drainedUnderRetired.sent.length,
    1,
    "a retired revision's watermark cannot strand the re-tiered refs below it"
  );
  assert.ok(
    drainedUnderRetired.source.advanceCalls.some(
      (call) => call.sourceKey === buildAgentSessionSyncSourceKey(TARGET, true)
    ),
    "the replay advances the current revision's cursor"
  );
});

async function refreshAndSettle(
  service: AgentSessionSyncService
): Promise<void> {
  service.refresh();
  await service.whenSessionSyncSettled();
  await settleSelfContinuedDrain(service);
}

/** Drain a capable-cloud sync whose ONLY persisted cursor is `sourceKey`. */
async function drainWithSeededCursor(sourceKey: string): Promise<{
  sent: AgentSessionSyncBatch[];
  source: CapabilityProjectingSource;
}> {
  const source = new CapabilityProjectingSource([
    {
      ...makeSyncedSession(SESSION_ID, UPDATED_AT),
      artifactRefs: [activityRef],
    },
  ]);
  source.seedSyncState(sourceKey, {
    observedTopUpdatedAt: UPDATED_AT,
    observedIdsAtTopUpdatedAt: [SESSION_ID],
  });
  const sent: AgentSessionSyncBatch[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => TARGET,
    isSyncMonitoredActivitySupported: () => true,
    sendBatch: (batch) => {
      sent.push(batch);
      return Promise.resolve({ accepted: true });
    },
  });

  try {
    service.start();
    await settleSelfContinuedDrain(service);
  } finally {
    service.stop();
  }
  return { sent, source };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type TraceCommentTarget,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import type { SessionAttributionResolverCache } from "../src/main/agent-sync/agent-session-attribution.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  syncCloudSessionForTraceComments,
  type TraceCommentParentSessionRecoveryOptions,
} from "../src/main/trace-comments/trace-comment-parent-session-recovery.js";

const SESSION_TARGET: TraceCommentTarget = {
  type: TraceCommentTargetType.Session,
  id: "sess-1",
};
const COMPUTE_TARGET_ID = "ct-1";
const CREDENTIALS_UNAVAILABLE_PATTERN = /credentials unavailable/;

/**
 * A session source that records whether it was consulted. When it IS consulted
 * (the gate opened), it returns a minimal parent session so the recovery path
 * proceeds to the post step.
 */
function recordingSyncSource(): {
  source: AgentSessionSyncSource;
  loadCalls: string[][];
} {
  const loadCalls: string[][] = [];
  const source = {
    loadSyncedSessions: (
      ids: string[],
      _cache: SessionAttributionResolverCache
    ): Promise<SyncedAgentSession[]> => {
      loadCalls.push(ids);
      return Promise.resolve([baseSession()]);
    },
  } as unknown as AgentSessionSyncSource;
  return { source, loadCalls };
}

function baseOptions(
  overrides: Partial<TraceCommentParentSessionRecoveryOptions> = {}
): TraceCommentParentSessionRecoveryOptions {
  return {
    getComputeTargetId: () => COMPUTE_TARGET_ID,
    // No getApiOrigin → the post step throws "credentials unavailable" AFTER
    // the gate/load, which is enough to prove the gate opened without a real
    // network call. Overridden per-test as needed.
    ...overrides,
  };
}

test("FEA-4169: policy OFF never loads or posts the parent session", async () => {
  const { source, loadCalls } = recordingSyncSource();

  await syncCloudSessionForTraceComments(
    source,
    SESSION_TARGET,
    baseOptions({ isSessionSyncAllowed: () => false })
  );

  // The denied case must never consult the session source (and thus never
  // reach the /desktop/agent-sessions/sync POST).
  assert.deepEqual(loadCalls, []);
});

test("FEA-4169: policy ON opens the gate and loads the parent session for sync", async () => {
  const { source, loadCalls } = recordingSyncSource();

  // The post step will throw "credentials unavailable" (no getApiOrigin), which
  // proves the gate opened and the load ran — exactly the branch we want.
  await assert.rejects(
    () =>
      syncCloudSessionForTraceComments(
        source,
        SESSION_TARGET,
        baseOptions({ isSessionSyncAllowed: () => true })
      ),
    CREDENTIALS_UNAVAILABLE_PATTERN
  );

  assert.deepEqual(loadCalls, [["sess-1"]]);
});

test("FEA-4169: omitted policy probe stays allowed (pre-FEA-4169 backward compat)", async () => {
  const { source, loadCalls } = recordingSyncSource();

  await assert.rejects(
    () =>
      syncCloudSessionForTraceComments(source, SESSION_TARGET, baseOptions()),
    CREDENTIALS_UNAVAILABLE_PATTERN
  );

  // No isSessionSyncAllowed → treated as allowed, so the load still runs.
  assert.deepEqual(loadCalls, [["sess-1"]]);
});

test("non-session targets are a no-op regardless of policy", async () => {
  const { source, loadCalls } = recordingSyncSource();

  await syncCloudSessionForTraceComments(
    source,
    { type: TraceCommentTargetType.Branch, id: "branch-1" },
    baseOptions({ isSessionSyncAllowed: () => true })
  );

  assert.deepEqual(loadCalls, []);
});

function baseSession(): SyncedAgentSession {
  return {
    externalSessionId: "sess-1",
    status: "completed",
    harness: "codex",
    cwd: "/workspace/sess-1",
    startedAt: "2026-06-08T12:00:00.000Z",
    updatedAt: "2026-06-08T12:01:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
  };
}

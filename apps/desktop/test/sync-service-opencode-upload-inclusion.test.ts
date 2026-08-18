/**
 * @file sync-service-opencode-upload-inclusion.test.ts
 * @description ISS-4650 (ISS-4627 follow-up) — an OpenCode session must survive
 * the DOWNSTREAM sync stages, not merely be enumerated.
 *
 * The ISS-4627 landing guard
 * (`sync-source-opencode-harness-inclusion.test.ts`) proves an OpenCode session
 * is returned by `AgentSessionSyncSource.listAllSessionCursorRows()` — i.e. it
 * CAN enqueue. It does not prove it reaches the wire: everything between
 * enumeration and `sendBatch` (queue admission, the idle/phantom withhold, the
 * payload preparer, sanitization, chunking) is a place a harness allow-list
 * could still drop it.
 *
 * This suite drives the REAL `AgentSessionSyncService` and asserts on the
 * CAPTURED UPLOAD PAYLOAD:
 *   1. a seeded OpenCode session appears in `batch.sessions` alongside a Claude
 *      one, so the corpus is not trivially empty; and
 *   2. version-skew: an UNKNOWN/future harness value uploads too, never silently
 *      withheld.
 *
 * Mutation guard: a `harness IN (…)` filter anywhere between the cursor walk and
 * `sendBatch` that omits OpenCode (or a future harness) empties the captured set
 * here and fails this test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "@repo/lib/harness/types";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { settleSelfContinuedDrain } from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const COMPUTE_TARGET = "compute-target-iss4650";

// A harness value this build does not know (a newer Desktop/CLI shipping a
// harness before this build learned it). It must degrade to UPLOADED, not
// silently withheld — silent omission is the whole ISS-4627/ISS-4650 complaint.
const UNKNOWN_FUTURE_HARNESS = "future-cli";

function sessionWithHarness(id: string, harness: string): SyncedAgentSession {
  return { ...makeSyncedSession(id, "2026-06-08T13:00:00.000Z"), harness };
}

/**
 * Drive the real service over `sessions` and return every external session id
 * that actually crossed `sendBatch` — the upload payload, not the queue.
 */
async function captureUploadedSessionIds(
  sessions: SyncedAgentSession[]
): Promise<Set<string>> {
  const source = new FakeSyncSource(sessions);
  const uploaded = new Set<string>();
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: (batch) => {
      for (const session of batch.sessions) {
        uploaded.add(session.externalSessionId);
      }
      return Promise.resolve({ accepted: true as const });
    },
  });
  service.start();
  try {
    // Synchronizes on the service's own caught-up signal, never a sleep
    // (desktop AGENTS.md "test:node determinism"); throws rather than falling
    // through onto a stale snapshot if the drain never settles.
    await settleSelfContinuedDrain(service);
  } finally {
    service.stop();
  }
  return uploaded;
}

test("ISS-4650: an OpenCode session reaches the upload payload, not just the queue", async () => {
  const uploaded = await captureUploadedSessionIds([
    sessionWithHarness("s-claude", Harness.Claude),
    sessionWithHarness("s-opencode", Harness.OpenCode),
  ]);

  assert.ok(
    uploaded.has("s-opencode"),
    "the OpenCode session must appear in the captured sendBatch payload"
  );
  assert.ok(
    uploaded.has("s-claude"),
    "the Claude session uploads too (sanity: the corpus is not empty)"
  );
});

test("ISS-4650: an unknown/future harness reaches the upload payload (version-skew)", async () => {
  const uploaded = await captureUploadedSessionIds([
    sessionWithHarness("s-future", UNKNOWN_FUTURE_HARNESS),
  ]);

  assert.ok(
    uploaded.has("s-future"),
    "an unknown harness must still upload (default-include, never silently withheld)"
  );
});

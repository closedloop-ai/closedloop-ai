/**
 * @file agent-session-sync-empty-hydration.test.ts
 * @description ISS-6031: an EMPTY `loadSyncedSessions` result is not evidence of
 * a deletion, and the sync lane may no longer destroy data on it.
 *
 * The measured defect: against a clone of a real 2.1 GB store, five sessions
 * were permanently dead-lettered on EVERY cycle — 10+ consecutive cycles, clean
 * and crash modes alike — while their rows were still present in `sessions`. The
 * empty-hydration branch treated "the read returned nothing" as "the rows were
 * locally deleted after enqueue", dequeued them, and marked them `dead_lettered`
 * so the redrive re-failed them identically. It also logged that deletion as a
 * fact, sending the investigation after a delete nobody had performed.
 *
 * A focused sibling suite rather than another cluster in the 141 KB
 * `agent-session-sync-service.test.ts`, which is on the biome shrink-only
 * grandfather list (per `test/AGENTS.md`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  flushAgentSessionSync,
  makeServiceWithIdentity,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const TARGET = "target-iss-6031";
const SOURCE_KEY = buildAgentSessionSyncSourceKey(TARGET);
const SESSION_ID = "present-but-unreadable";
const UPDATED_AT = "2026-08-11T12:01:00.000Z";

/**
 * The exact production shape: the row is PRESENT in `sessions` (so the presence
 * probe finds it) while the hydration read comes back empty. That is what the
 * soak measured — activity metrics, analytics and segments all intact for the
 * dropped ids — and what the old branch mislabelled as a deletion.
 */
class UnreadableHydrationSource extends FakeSyncSource {
  loadCallCount = 0;
  /**
   * When true, the ids are ALSO removed from the backing `sessions` map at load
   * time — a real delete-after-enqueue, which the presence probe can then prove.
   * Deleting before `start()` instead would empty the cursor enumeration and the
   * session would never be queued at all, so the branch under test never runs
   * (this mirrors `ResettingSyncSource.onLoad` in the FEA-3473 suite).
   */
  deleteOnLoad = false;

  override loadSyncedSessions(ids: string[]): SyncedAgentSession[] {
    this.loadCallCount += 1;
    // Record the request exactly as the base class would, then answer empty.
    this.loadSyncedSessionIds.push(ids);
    if (this.deleteOnLoad) {
      for (const id of ids) {
        this.deleteSession(id);
      }
    }
    return [];
  }
}

function outboxRowFor(source: FakeSyncSource, id: string) {
  return [...source.outbox.values()].find(
    (row) => row.sourceKey === SOURCE_KEY && row.id === id
  );
}

function warningsMentioning(id: string): string[] {
  return gatewayLog
    .getEntries()
    .filter((entry) => entry.level === "warn" && entry.message.includes(id))
    .map((entry) => entry.message);
}

test("ISS-6031: an empty hydration of a session still present in `sessions` is NOT dead-lettered", async () => {
  gatewayLog.clear();
  const source = new UnreadableHydrationSource([
    makeSyncedSession(SESSION_ID, UPDATED_AT),
  ]);
  const sent: string[][] = [];
  const service = makeServiceWithIdentity(
    source,
    (batch) => {
      sent.push(batch.sessions.map((s) => s.externalSessionId));
      return Promise.resolve({ accepted: true as const });
    },
    TARGET
  );

  service.start();
  await flushAgentSessionSync();
  // Sampled BEFORE stop(): stop() resets all source-derived state, so a
  // dead-letter count read afterward would always be 0 and prove nothing.
  const progress = service.getSyncProgress();
  service.stop();

  assert.ok(
    source.loadCallCount > 0,
    "the production hydration path ran (otherwise this proves nothing)"
  );
  assert.deepEqual(sent, [], "nothing could be built, so nothing was sent");

  // THE REGRESSION. Before the fix this row was dequeued and permanently
  // dead-lettered on this very first pass, and again on every redrive.
  const outbox = outboxRowFor(source, SESSION_ID);
  assert.notEqual(
    outbox?.status,
    "dead_lettered",
    "a session whose row is still in `sessions` must never be dead-lettered on an empty read"
  );
  assert.equal(
    progress.deadLetteredSessions,
    0,
    "no dead-letter is recorded for a present session"
  );

  // The absence claim must have been CHECKED, not assumed.
  assert.deepEqual(
    source.findExistingSessionIdCalls,
    [[SESSION_ID]],
    "the service probed local presence before deciding anything"
  );

  // The log must state what was observed, not assert a cause nobody verified.
  const warnings = warningsMentioning(SESSION_ID);
  assert.ok(
    warnings.length > 0,
    "the withheld session is surfaced, not silently swallowed"
  );
  for (const message of warnings) {
    assert.ok(
      !message.includes("locally deleted"),
      `no warning may claim a local deletion: ${message}`
    );
  }
  assert.ok(
    warnings.some((message) => message.includes("still has a row")),
    "the warning reports the observation (the row is still present)"
  );
});

test("ISS-6031: a session that IS gone from `sessions` is still confirmed-absent and dead-lettered (FEA-3473 preserved)", async () => {
  gatewayLog.clear();
  const source = new UnreadableHydrationSource([
    makeSyncedSession(SESSION_ID, UPDATED_AT),
  ]);
  // A REAL local removal at the moment of hydration: the row leaves `sessions`,
  // so the presence probe can prove the absence and the FEA-3473 disposal path
  // is correct.
  source.deleteOnLoad = true;
  const service = makeServiceWithIdentity(
    source,
    async () => ({ accepted: true }),
    TARGET
  );

  service.start();
  await flushAgentSessionSync();
  service.stop();

  const outbox = outboxRowFor(source, SESSION_ID);
  assert.equal(
    outbox?.status,
    "dead_lettered",
    "a PROVEN absence is still recorded rather than silently dropped"
  );
  assert.equal(
    outbox?.reason,
    "unhydratable",
    "the outbox/telemetry reason string is a contract and is unchanged"
  );
  for (const message of warningsMentioning(SESSION_ID)) {
    assert.ok(
      !message.includes("locally deleted"),
      `even the confirmed-absent line reports the observation, not a cause: ${message}`
    );
  }
});

test("ISS-6031: a source with no presence probe can never confirm an absence, so nothing is disposed of", async () => {
  gatewayLog.clear();
  const source = new UnreadableHydrationSource([
    makeSyncedSession(SESSION_ID, UPDATED_AT),
  ]);
  // A legacy/fake source that predates the probe. It cannot establish absence,
  // and "cannot establish" must resolve toward retry — a wrong retry costs a
  // read, a wrong disposal costs the only copy of the data.
  Reflect.set(source, "findExistingSessionIds", undefined);
  const service = makeServiceWithIdentity(
    source,
    async () => ({ accepted: true }),
    TARGET
  );

  service.start();
  await flushAgentSessionSync();
  service.stop();

  assert.notEqual(
    outboxRowFor(source, SESSION_ID)?.status,
    "dead_lettered",
    "an unverifiable absence must not be treated as a proven one"
  );
});

test("ISS-6031: a PARTIAL hydration miss is accounted for, not silently omitted from the batch", async () => {
  gatewayLog.clear();
  const MISSING = "missing-from-hydration";
  const HYDRATES = "hydrates-fine";
  // The aggregate count is non-zero, so the old `length === 0` branch never
  // fired: the unhydrated id was dropped from the batch, never probed, never
  // logged, and left to be re-picked forever. Same fail-silent hazard, hidden
  // behind a partial success.
  class PartialMissSource extends FakeSyncSource {
    override loadSyncedSessions(ids: string[]) {
      return super.loadSyncedSessions(ids.filter((id) => id !== MISSING));
    }
  }
  const source = new PartialMissSource([
    makeSyncedSession(MISSING, "2026-08-12T03:29:06.102Z"),
    makeSyncedSession(HYDRATES, "2026-08-12T03:30:00.000Z"),
  ]);
  const service = makeServiceWithIdentity(
    source,
    () => Promise.resolve({ accepted: true as const }),
    TARGET
  );

  service.start();
  await flushAgentSessionSync();
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.ok(
    source.findExistingSessionIdCalls.flat().includes(MISSING),
    "the id the hydration did not return is probed, not silently skipped"
  );
  assert.notEqual(
    outboxRowFor(source, MISSING)?.status,
    "dead_lettered",
    "it is still present in `sessions`, so it must not be disposed of"
  );
  assert.ok(
    warningsMentioning(MISSING).length > 0,
    "the partial miss is surfaced rather than swallowed"
  );
});

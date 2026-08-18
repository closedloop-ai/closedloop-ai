/**
 * @file agent-session-sync-outbox-reconcile.test.ts
 * @description ISS-6031 (selection totality): a `pending` outbox row that
 * neither in-memory queue is tracking must still be selected.
 *
 * Measured live in the certification battery: session
 * `cc3aea3c-02b5-459b-9e3a-df3b321a5bad` sat `pending`, `attempt_count = 0`,
 * `next_attempt_at` and `last_error` NULL, for 11+ minutes after a full drain —
 * never selected, never attempted, nothing logged. The backlog stayed pinned at
 * depth 1 until the cycle's budget killed it. A hang is worse than a failure
 * because it emits no signal, and the acceptance criterion it breaks ("drains to
 * zero") cannot distinguish it from slow progress.
 *
 * The outbox was only ever re-read into the queues on RESUME, so any dequeue
 * path that dropped an id without resolving its row stranded it until the next
 * process start. The reconciliation makes the outbox authoritative on every idle
 * tick instead, which closes the hole for every such path rather than one at a
 * time.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  flushAgentSessionSync,
  makeServiceWithIdentity,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const TARGET = "target-iss-6031-reconcile";
const SOURCE_KEY = buildAgentSessionSyncSourceKey(TARGET);
const STRANDED = "stranded-pending-row";
const NEIGHBOR = "neighbor";

async function drain(
  service: ReturnType<typeof makeServiceWithIdentity>,
  ticks: number
): Promise<void> {
  service.start();
  await flushAgentSessionSync();
  for (let i = 1; i < ticks; i += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
}

test("ISS-6031: a pending outbox row no queue is tracking is reconciled back onto the backfill lane and sent", async () => {
  gatewayLog.clear();
  const source = new FakeSyncSource([
    makeSyncedSession(STRANDED, "2026-08-12T03:29:06.102Z"),
  ]);
  // The exact stranded shape: the row is owed (pending in the durable outbox)
  // but the cursor has already walked past it, so nothing enumerates it. Before
  // the fix this could only be recovered by restarting the process.
  source.seedOutbox(SOURCE_KEY, STRANDED);
  source.seedSyncState(SOURCE_KEY, {
    observedTopUpdatedAt: "2026-08-12T03:38:25.995Z",
    observedIdsAtTopUpdatedAt: [],
  });

  const sent: string[][] = [];
  const service = makeServiceWithIdentity(
    source,
    (batch) => {
      sent.push(batch.sessions.map((s) => s.externalSessionId));
      return Promise.resolve({ accepted: true as const });
    },
    TARGET
  );
  await drain(service, 4);
  service.stop();

  assert.ok(
    sent.flat().includes(STRANDED),
    "the stranded pending row is eventually selected and sent"
  );
  const outbox = [...source.outbox.values()].find(
    (row) => row.sourceKey === SOURCE_KEY && row.id === STRANDED
  );
  assert.equal(
    outbox,
    undefined,
    "its durable row is cleared on the verified ack, so the backlog reaches zero"
  );
});

test("ISS-6031: a permanently-stuck row keeps the rest of the queue draining AND stays reachable", async () => {
  gatewayLog.clear();
  // `stuck` never hydrates but IS still present in `sessions`, so it can never be
  // disposed of (an empty read is not a deletion). It must not block `neighbor`,
  // and it must not fall out of the system either.
  class PartiallyUnreadableSource extends FakeSyncSource {
    override loadSyncedSessions(ids: string[]) {
      const readable = ids.filter((id) => id !== STRANDED);
      return super.loadSyncedSessions(readable);
    }
  }
  const source = new PartiallyUnreadableSource([
    makeSyncedSession(STRANDED, "2026-08-12T03:29:06.102Z"),
    makeSyncedSession(NEIGHBOR, "2026-08-12T03:30:00.000Z"),
  ]);
  source.seedOutbox(SOURCE_KEY, STRANDED);

  const sent: string[][] = [];
  const service = makeServiceWithIdentity(
    source,
    (batch) => {
      sent.push(batch.sessions.map((s) => s.externalSessionId));
      return Promise.resolve({ accepted: true as const });
    },
    TARGET
  );
  await drain(service, 6);
  const progress = service.getSyncProgress();
  service.stop();

  assert.ok(
    sent.flat().includes(NEIGHBOR),
    "a row that cannot be read must not block the rest of the queue"
  );
  const stuckOutbox = [...source.outbox.values()].find(
    (row) => row.sourceKey === SOURCE_KEY && row.id === STRANDED
  );
  assert.equal(
    stuckOutbox?.status,
    "pending",
    "the unreadable row is still owed — not dead-lettered, not silently gone"
  );
  assert.equal(
    progress.deadLetteredSessions,
    0,
    "nothing is disposed of on an unproven absence"
  );
  // Reachability is the property that failed live: the row must be back on a
  // queue (or about to be re-fed by the reconciler), never orphaned.
  assert.ok(
    source.findExistingSessionIdCalls.length > 0,
    "the lane keeps probing the stuck row rather than forgetting it"
  );
});

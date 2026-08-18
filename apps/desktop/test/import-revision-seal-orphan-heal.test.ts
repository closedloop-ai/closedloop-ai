/**
 * @file import-revision-seal-orphan-heal.test.ts
 * @description ISS-4572 (R2) DB-backed regression coverage for the orphaned-row
 * hazard the task-scoped write-queue eviction created if left unhandled.
 *
 * The isolated import commits each record group in its OWN write-queue
 * transaction. Before this fix the FK-parent gate stamped the session row at the
 * CURRENT `DATA_REVISION` up front; if a later group's write was then EVICTED (the
 * per-session import timeout cancelling a genuinely-wedged write), the row was left
 * committed at the current revision with its events / token_usage / artifact-link
 * groups missing — and `data-revision-rebuild` (which re-derives only rows whose
 * `data_revision` differs from the current value) would never re-heal it, so it
 * rendered as a fully-imported session with zero events until the next boot's
 * re-import.
 *
 * The fix stamps a PENDING sentinel (`DATA_REVISION_IMPORT_PENDING`) at the gate
 * and SEALS the real `DATA_REVISION` only after every group commits WITHOUT an
 * eviction. These tests drive the REAL `createSqliteImporter.importSession`
 * against a live libSQL store through the REAL `createWriteQueue`, and pin:
 *   1. a clean import ends SEALED at the current DATA_REVISION;
 *   2. an import whose later group is EVICTED mid-flight is left at the PENDING
 *      sentinel (never the current revision), so the rebuild re-heals it — proving
 *      no orphaned-at-current-revision row;
 *   3. a re-import of a sentinel-stamped row heals it back to the current revision;
 *   4. (ISS-6003) an eviction stops the import queuing further groups and still
 *      emits the group report NAMING the evicted group — asserted while the
 *      abandoned transaction is still holding the writer, which is the state the
 *      production wedge is stuck in.
 *
 * Synchronization is on injected completion signals (`deferred`), never a poll or
 * wall-clock wait — the queue wrapper resolves a signal the instant the target
 * later group reaches the head, so the test cancels at exactly that point.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DATA_REVISION,
  DATA_REVISION_IMPORT_PENDING,
} from "../src/main/collectors/engine/data-revision.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { SLOW_IMPORT_GROUP_LOG_PREFIX } from "../src/main/database/import-group-telemetry.js";
import type { WriteSerializer } from "../src/main/database/prisma-client.js";
import { createSqliteTokenUsageStore } from "../src/main/database/read-stores.js";
import { createSqliteImporter } from "../src/main/database/write-core.js";
import {
  createWriteQueue,
  type WriteQueue,
  WriteQueueCancelOutcome,
  type WriteQueueTaskToken,
} from "../src/main/database/write-queue.js";
import { deferred } from "./deferred.js";
import { makeSession as baseSession } from "./normalized-session-test-utils.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

const NOW = "2026-07-10T12:00:00.000Z";
/**
 * ISS-6003: bounds the eviction-report case explicitly. It asserts that the
 * import RETURNS while its own abandoned transaction still holds the writer, so
 * the failure mode of a regression is a hang — the default runner timeout is not
 * a contract, this is.
 */
const EVICTION_REPORT_TIMEOUT_MS = 30_000;
const EVICTED_EVENTS_GROUP_RE = /evicted=events/;
const STARTED_AT = "2026-07-01T12:00:00.000Z";
const ASSISTANT_TS = "2026-07-01T12:03:00.000Z";
const ENDED_AT = "2026-07-01T12:05:30.000Z";
const OLD_FILE_MTIME_MS = Date.parse("2026-07-01T12:00:00.000Z");

function fixture(sessionId: string): NormalizedSession {
  return baseSession({
    sessionId,
    cwd: "/sandbox/project",
    model: "claude-opus-4-5",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    fileModifiedAt: OLD_FILE_MTIME_MS,
    userMessages: 1,
    assistantMessages: 1,
    messages: [{ role: "assistant", timestamp: ASSISTANT_TS, text: "hello" }],
    tokensByModel: { "claude-opus-4-5": { input: 10, output: 5 } },
    // A single tool use so the import materializes a component invocation and its
    // sync-outbox row — the surface whose `data_revision` the seal must NOT leave
    // at the PENDING sentinel (the outbox-revision regression pinned below).
    toolUses: [{ name: "read_file", timestamp: ASSISTANT_TS }],
  });
}

async function readOutboxDataRevisions(
  h: OpenTestPrisma,
  sessionId: string
): Promise<number[]> {
  const rows = await h.prisma.client.$queryRawUnsafe<
    Array<{ data_revision: number }>
  >(
    "SELECT data_revision FROM agent_component_invocation_sync_outbox WHERE external_session_id = $1",
    sessionId
  );
  return rows.map((row) => Number(row.data_revision));
}

async function readDataRevision(
  h: OpenTestPrisma,
  sessionId: string
): Promise<number | null> {
  const rows = await h.prisma.client.$queryRawUnsafe<
    Array<{ data_revision: number }>
  >("SELECT data_revision FROM sessions WHERE id = $1", sessionId);
  const raw = rows[0]?.data_revision;
  return raw == null ? null : Number(raw);
}

function importerFor(
  h: OpenTestPrisma,
  queue: Pick<WriteQueue, "cancel">,
  log: (message: string) => void = () => {
    // discarded unless a test asserts on the import's own log output
  }
): ReturnType<typeof createSqliteImporter> {
  const tokenUsage = createSqliteTokenUsageStore(h.prisma);
  return createSqliteImporter(h.prisma, tokenUsage, {
    detectBillingMode: () => "metered_api",
    now: () => NOW,
    log,
    cancelInFlightWrite: (sessionId, reason) => queue.cancel(sessionId, reason),
  });
}

test("ISS-4572 (R2): a clean import ends SEALED at the current DATA_REVISION", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4572-seal-clean-"));
  const queue = createWriteQueue();
  const h = await openTestPrisma(queue);
  try {
    const importer = importerFor(h, queue);
    const result = await importer.importSession(fixture("clean-1"), "claude");
    assert.equal(result.skipped, false);
    assert.equal(
      await readDataRevision(h, "clean-1"),
      DATA_REVISION,
      "a clean import seals the real revision"
    );
    // ISS-4572 regression: the invocation-sync outbox must record the DERIVATION
    // revision (the current DATA_REVISION), NOT the DATA_REVISION_IMPORT_PENDING
    // sentinel the isolated-import gate stamps on the session row. The seal does
    // not re-derive the outbox (the generation id is revision-independent), so if
    // the outbox read `data_revision` off the sentinel-stamped session row it
    // would leak the sentinel into the outbox `data_revision`/`part_hash`/payload
    // — the drift that reddened the golden layer2 snapshots.
    const outboxRevisions = await readOutboxDataRevisions(h, "clean-1");
    assert.ok(
      outboxRevisions.length > 0,
      "the import materialized at least one invocation-sync outbox row"
    );
    for (const revision of outboxRevisions) {
      assert.equal(
        revision,
        DATA_REVISION,
        "the outbox row is stamped at the sealed DATA_REVISION, never the pending sentinel"
      );
    }
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4572 (R2): an import whose later group is EVICTED is left at the PENDING sentinel (no orphan at current revision)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4572-seal-evict-"));
  const sessionId = "evicted-mid-import";

  // A queue wrapper over the REAL queue that, on the SECOND write tagged with the
  // target session (the first post-gate group), parks it at the head and signals
  // the test — which then cancels THAT session's task, evicting the later group
  // exactly as the per-session import timeout would.
  const inner = createWriteQueue();
  let targetWriteCount = 0;
  const laterGroupAtHead = deferred<void>();
  const releaseLaterGroup = deferred<void>();
  const wrapper: WriteSerializer & Pick<WriteQueue, "cancel"> = {
    run<T>(fn: () => Promise<T>, token?: WriteQueueTaskToken): Promise<T> {
      if (token !== sessionId) {
        return inner.run(fn, token);
      }
      targetWriteCount += 1;
      if (targetWriteCount === 2) {
        // The first post-gate group: park it at the head so the test can evict it.
        return inner.run(async () => {
          laterGroupAtHead.resolve();
          await releaseLaterGroup.promise;
          return fn();
        }, token);
      }
      return inner.run(fn, token);
    },
    cancel: (token, reason) => inner.cancel(token, reason),
  };

  const h = await openTestPrisma(wrapper);
  try {
    const importer = importerFor(h, wrapper);
    const importDone = importer.importSession(fixture(sessionId), "claude");

    // Wait until the first post-gate group is at the head, then evict THIS
    // session's task — the eviction rejects it with WriteQueueCancelledError.
    await laterGroupAtHead.promise;
    const evicted = importer.cancelInFlightWrite?.(sessionId);
    assert.equal(
      evicted,
      WriteQueueCancelOutcome.Running,
      "the session's own in-flight write was evicted"
    );
    // Let the abandoned write drain so the queue tail advances (split-write safe).
    releaseLaterGroup.resolve();
    const result = await importDone;
    assert.equal(
      result.incomplete,
      true,
      "an evicted group marks the import incomplete (re-import next pass)"
    );

    // The gate stamped the PENDING sentinel and the seal was SUPPRESSED by the
    // cancellation, so the row is NOT at the current revision — the rebuild will
    // re-derive it rather than treating it as fully imported.
    assert.equal(
      await readDataRevision(h, sessionId),
      DATA_REVISION_IMPORT_PENDING,
      "an evicted import is left at the pending sentinel, never the current revision"
    );
    assert.notEqual(
      await readDataRevision(h, sessionId),
      DATA_REVISION,
      "the orphaned-at-current-revision hazard cannot occur"
    );
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4572 (R2): re-importing a sentinel-stamped session heals it back to the current revision", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4572-seal-heal-"));
  const sessionId = "heal-after-sentinel";
  const queue = createWriteQueue();
  const h = await openTestPrisma(queue);
  try {
    const importer = importerFor(h, queue);
    // Seed a row already stamped at the pending sentinel (as an interrupted import
    // would leave it), then re-import — the gate's revision-only heal detects the
    // stale marker and the seal promotes it to the current revision.
    await importer.importSession(fixture(sessionId), "claude");
    await h.prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE sessions SET data_revision = $1 WHERE id = $2",
        DATA_REVISION_IMPORT_PENDING,
        sessionId
      )
    );
    assert.equal(
      await readDataRevision(h, sessionId),
      DATA_REVISION_IMPORT_PENDING
    );

    await importer.importSession(fixture(sessionId), "claude");
    assert.equal(
      await readDataRevision(h, sessionId),
      DATA_REVISION,
      "a re-import heals a sentinel-stamped row to the current revision"
    );
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-6003: an evicted import stops queuing groups and still names the evicted one", {
  timeout: EVICTION_REPORT_TIMEOUT_MS,
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6003-evict-report-"));
  const sessionId = "evicted-names-the-group";

  // Same harness as the seal test above: park the FIRST post-gate group (the
  // `events` group) at the head so the test can evict it there. The difference
  // is what happens next — this one NEVER releases the abandoned write before
  // asserting, which is the real wedge's shape.
  const inner = createWriteQueue();
  let targetWriteCount = 0;
  const laterGroupAtHead = deferred<void>();
  const releaseLaterGroup = deferred<void>();
  const wrapper: WriteSerializer & Pick<WriteQueue, "cancel"> = {
    run<T>(fn: () => Promise<T>, token?: WriteQueueTaskToken): Promise<T> {
      if (token !== sessionId) {
        return inner.run(fn, token);
      }
      targetWriteCount += 1;
      if (targetWriteCount === 2) {
        return inner.run(async () => {
          laterGroupAtHead.resolve();
          await releaseLaterGroup.promise;
          return fn();
        }, token);
      }
      return inner.run(fn, token);
    },
    cancel: (token, reason) => inner.cancel(token, reason),
  };

  const lines: string[] = [];
  const h = await openTestPrisma(wrapper);
  try {
    const importer = importerFor(h, wrapper, (message) => lines.push(message));
    const importDone = importer.importSession(fixture(sessionId), "claude");

    await laterGroupAtHead.promise;
    assert.equal(
      importer.cancelInFlightWrite?.(sessionId),
      WriteQueueCancelOutcome.Running,
      "the session's own in-flight write was evicted"
    );

    // The abandoned transaction is DELIBERATELY still holding the writer here.
    // Eviction rejects only the caller, so before ISS-6003 the import queued
    // its NEXT group and blocked on this very task — it never reached the
    // report, which is exactly the persistent wedge the report exists for.
    // MUTATION: restore the old "keep queuing after a cancellation" behavior
    // and this await never settles, so the case fails on the timeout above.
    const result = await importDone;

    assert.equal(
      result.incomplete,
      true,
      "an evicted group still marks the import incomplete"
    );
    assert.equal(
      targetWriteCount,
      2,
      "the gate and the evicted group are the only writes queued — nothing more after the eviction"
    );
    const report = lines.find((line) =>
      line.startsWith(SLOW_IMPORT_GROUP_LOG_PREFIX)
    );
    assert.ok(report, "the import emitted the ISS-6003 group report");
    assert.match(
      report,
      EVICTED_EVENTS_GROUP_RE,
      "the report names the group that was holding the writer"
    );
    assert.equal(
      await readDataRevision(h, sessionId),
      DATA_REVISION_IMPORT_PENDING,
      "skipping the remaining groups still leaves the row at the pending sentinel"
    );
  } finally {
    // Release the abandoned write and let the queue drain before disconnecting.
    releaseLaterGroup.resolve();
    await inner.drain();
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});

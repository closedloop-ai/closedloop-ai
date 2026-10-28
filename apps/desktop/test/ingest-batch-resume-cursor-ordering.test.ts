/**
 * @file ingest-batch-resume-cursor-ordering.test.ts
 * @description ISS-9839 (ISS-9837 R4/C1): the ORDERING invariant that is the
 * ISS-5161 cursor's actual durability guarantee.
 *
 * State it in R4's words: **the cursor must never name a session whose data is
 * not already committed.** That is what prevents a SKIP, and it was never a
 * synchrony property of the `writeFileSync` this store used to use — it is
 * enforced by `collector-manager.ts`, which checkpoints only a session that
 * imported durably AND was not `incomplete`. An async write-back therefore
 * cannot violate it: a write that never lands leaves the cursor BEHIND committed
 * data (a replayed prefix, which costs time), never AHEAD of it (a skipped
 * session, which is data loss).
 *
 * Proving "the write happens" would not prove that. What proves it is quantifying
 * over CRASH POINTS: a hard kill can freeze the durable cursor at any state it
 * was ever written in, so the invariant holds only if EVERY payload the store is
 * ever asked to write names only sessions the sink had already committed. The
 * case below records every such payload and checks all of them, so a checkpoint
 * that ran before its commit — or one that checkpointed a partially-committed
 * session — fails here no matter which instant the kill is imagined at.
 *
 * The second case pins C2 at the terminal flush site the ticket calls the
 * ordinary quit path: `stop()` must not RESOLVE until the cursor write has
 * landed. The Electron quit awaits `shutdown()` behind a hard-exit timeout, so a
 * `stop()` that resolves early hands the process back while the checkpoint is
 * still in flight — which converts ISS-5161's bounded replay into an unbounded
 * one, by a new route. It is asserted as an ORDER of observed events rather than
 * as an elapsed window, so no timer decides the result.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import type {
  BatchResumeCursorStore,
  PersistedBatchResumeCursors,
} from "../src/main/collectors/engine/collector-manager-batch-resume.js";
import type { HarnessCollector } from "../src/main/collectors/types.js";
import { deferred } from "./deferred.js";
import { batchResumeCursorMedium } from "./helpers/batch-resume-cursor-fixtures.js";
import {
  fakeFsWatcher,
  noopCooperativeDelay,
} from "./helpers/collector-manager-fixtures.js";
import { fakeCollector, makeSession } from "./normalized-session-test-utils.js";

const OPENCODE = "opencode";
const FINGERPRINT = "opencode.db:1000:512";
const BATCH_SESSION_COUNT = 40;
/** Sessions imported before the quit, so the pass is interrupted mid-source. */
const IMPORTS_BEFORE_QUIT = 15;
/**
 * Sessions whose import commits only SOME of its record groups. Every one of
 * these is a session the sink does not fully hold, so none may ever appear in a
 * written cursor. Spread across the prefix so a checkpoint that is merely one
 * behind cannot pass by accident.
 */
const INCOMPLETE_SESSION_IDS = new Set(["batch-2", "batch-7", "batch-11"]);
/** A session whose import failed outright — nothing committed for it at all. */
const FAILED_SESSION_ID = "batch-5";
/**
 * The pass is stopped from inside the importer, so a regression that never
 * settles would otherwise hang on the runner default (apps/desktop test:node
 * determinism rule).
 */
const TEST_CASE_TIMEOUT_MS = 15_000;

/** Every payload the cursor asked its durable store to write, in order. */
type WriteLog = {
  store: BatchResumeCursorStore;
  payloads: PersistedBatchResumeCursors[];
};

function recordingCursorStore(): WriteLog {
  const medium = batchResumeCursorMedium();
  const payloads: PersistedBatchResumeCursors[] = [];
  return {
    payloads,
    store: {
      byteLength: () => medium.port.byteLength(),
      read: () => medium.port.read(),
      write: async (payload) => {
        payloads.push(payload);
        await medium.port.write(payload);
      },
    },
  };
}

/** Every session id named by a written payload, across all of them. */
function checkpointedIds(payloads: PersistedBatchResumeCursors[]): string[] {
  const ids: string[] = [];
  for (const payload of payloads) {
    const cursors = JSON.parse(payload.cursors) as Record<
      string,
      { sessionIds: string[] }
    >;
    for (const entry of Object.values(cursors)) {
      ids.push(...entry.sessionIds);
    }
  }
  return ids;
}

test("ISS-9839 (ISS-9837 C1): no state the cursor is ever written in names a session the sink had not committed", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-9839-cursor-ordering-"));
  const source = join(dir, "opencode.db");
  writeFileSync(source, "{}\n");
  try {
    const log = recordingCursorStore();
    // What the SINK holds: only sessions whose import committed every record
    // group. Recorded by the importer at the moment it commits, so a checkpoint
    // written before its commit shows up as an id that is not in here yet.
    const fullyCommitted = new Set<string>();
    const attempted: string[] = [];

    const collector = (): HarnessCollector => {
      const base = fakeCollector(OPENCODE, {
        batch: true,
        sources: [source],
        watchRoots: [dir],
        parse: (path) =>
          Promise.resolve(
            path === source
              ? Array.from({ length: BATCH_SESSION_COUNT }, (_unused, index) =>
                  makeSession({ sessionId: `batch-${index}` })
                )
              : []
          ),
      });
      return {
        ...base,
        sourceFingerprint: () => FINGERPRINT,
        markSourceImported: () => true,
      };
    };

    const quit = deferred();
    let manager: CollectorManager | null = null;
    let stopped: Promise<void> = Promise.resolve();
    manager = new CollectorManager({
      importer: {
        importSession: (session) => {
          attempted.push(session.sessionId);
          const failed = session.sessionId === FAILED_SESSION_ID;
          const incomplete = INCOMPLETE_SESSION_IDS.has(session.sessionId);
          if (!(failed || incomplete)) {
            fullyCommitted.add(session.sessionId);
          }
          if (attempted.length === IMPORTS_BEFORE_QUIT) {
            // A quit lands mid-source. Whatever the cursor has written by now is
            // what a hard kill would freeze.
            stopped = manager?.stop() ?? Promise.resolve();
            quit.resolve();
          }
          return { skipped: false, reactivated: false, failed, incomplete };
        },
      },
      stateDir: dir,
      batchResumeCursorStore: log.store,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      catchupPollMs: null,
      log: () => {},
      watchDirectory: () => fakeFsWatcher(),
      collectors: [collector()],
    });
    manager.start();
    await quit.promise;
    await stopped;

    // The fixture has to have actually exercised the interesting sessions, or
    // every assertion below is vacuously true.
    assert.ok(
      attempted.includes(FAILED_SESSION_ID),
      `the pass must reach the failed session: ${JSON.stringify(attempted)}`
    );
    for (const id of INCOMPLETE_SESSION_IDS) {
      assert.ok(
        attempted.includes(id),
        `the pass must reach the incomplete session ${id}: ${JSON.stringify(attempted)}`
      );
    }
    assert.ok(
      log.payloads.length > 0,
      "the cursor must actually have been written, or there is no crash point to quantify over"
    );

    const checkpointed = checkpointedIds(log.payloads);
    assert.ok(
      checkpointed.length > 0,
      "a written cursor that names no session cannot demonstrate the invariant"
    );
    for (const id of checkpointed) {
      assert.ok(
        fullyCommitted.has(id),
        `every checkpointed session must already be committed in the sink; ${id} was not (checkpointed: ${JSON.stringify([...new Set(checkpointed)])}, committed: ${JSON.stringify([...fullyCommitted])})`
      );
    }
    // Named explicitly, because these are the two ways the cursor could get
    // AHEAD of the data and the generic subset check above would still pass if
    // the fixture stopped producing them.
    assert.equal(
      checkpointed.includes(FAILED_SESSION_ID),
      false,
      "a session whose import failed committed nothing and must never be checkpointed"
    );
    for (const id of INCOMPLETE_SESSION_IDS) {
      assert.equal(
        checkpointed.includes(id),
        false,
        `a partially-committed session must never be checkpointed: ${id}`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-9839 (ISS-9837 C2): stop() does not resolve until the terminal cursor flush has landed", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-9839-terminal-flush-"));
  const source = join(dir, "opencode.db");
  writeFileSync(source, "{}\n");
  try {
    const medium = batchResumeCursorMedium();
    // The durable write is held open by the test, so "did stop() wait for it" is
    // a fact about the order these events were recorded in rather than a race
    // the test has to win.
    const writeReleased = deferred();
    const writeSettled = deferred();
    const events: string[] = [];
    const gatedStore: BatchResumeCursorStore = {
      byteLength: () => medium.port.byteLength(),
      read: () => medium.port.read(),
      write: async (payload) => {
        events.push("write-started");
        await writeReleased.promise;
        await medium.port.write(payload);
        events.push("write-landed");
        writeSettled.resolve();
      },
    };

    const quit = deferred();
    let manager: CollectorManager | null = null;
    let stopping: Promise<void> = Promise.resolve();
    manager = new CollectorManager({
      importer: (() => {
        let imported = 0;
        return {
          importSession: () => {
            imported += 1;
            if (imported === IMPORTS_BEFORE_QUIT) {
              stopping = (manager?.stop() ?? Promise.resolve()).then(() => {
                events.push("stop-resolved");
              });
              quit.resolve();
            }
            return { skipped: false, reactivated: false };
          },
        };
      })(),
      stateDir: dir,
      batchResumeCursorStore: gatedStore,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      catchupPollMs: null,
      log: () => {},
      watchDirectory: () => fakeFsWatcher(),
      collectors: [
        (() => {
          const base = fakeCollector(OPENCODE, {
            batch: true,
            sources: [source],
            watchRoots: [dir],
            parse: (path) =>
              Promise.resolve(
                path === source
                  ? Array.from(
                      { length: BATCH_SESSION_COUNT },
                      (_unused, index) =>
                        makeSession({ sessionId: `batch-${index}` })
                    )
                  : []
              ),
          });
          return {
            ...base,
            sourceFingerprint: () => FINGERPRINT,
            markSourceImported: () => true,
          };
        })(),
      ],
    });
    manager.start();
    await quit.promise;
    writeReleased.resolve();
    await stopping;
    await writeSettled.promise;

    assert.deepEqual(
      events,
      ["write-started", "write-landed", "stop-resolved"],
      "the quit path must await its checkpoint: a stop() that resolves between the two write events has handed the process back with the cursor still in flight"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

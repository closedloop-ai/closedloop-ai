/**
 * @file ingest-parse-dispatch-deadline.test.ts
 * @description ISS-4572 regression (ISS-4444 follow-up), production-shaped through
 * the real `CollectorManager` + real `ParseQuarantine` store, driven by a runner
 * that reproduces the utility-process worker's SERIALIZED dispatch tail.
 *
 * R1 — request-scoped parse deadline. The five harness boot-import loops fan out
 * concurrently and share the runner's serialized dispatch (one worker turn at a
 * time), so a queued source waits behind an in-flight (poison) parse before its own
 * request is dispatched. If the manager's per-source parse deadline started at
 * ENQUEUE, the queued source would charge that queue wait to its own ~90s bound and
 * record a SPURIOUS quarantine attempt even though it parsed fine once dispatched.
 * The fix moves the deadline to DISPATCH: a source waiting in the queue has no
 * deadline running.
 *
 * This is the PRODUCTION-SHAPE proof: it drives the fix end-to-end through the real
 * `CollectorManager`, the real serialized shared runner (whose `onDispatch` fires
 * only at post-to-worker, past the dispatch tail), and the real `ParseQuarantine`
 * store — parking a healthy source behind poison parses on the shared runner and
 * asserting it imports with ZERO quarantine attempts recorded AND dispatched only
 * after waiting behind the poison turns. The DETERMINISTIC mutation guard for the
 * enqueue-vs-dispatch clock lives in `bounded-parse.test.ts`
 * ("the deadline does not start until dispatch…", fake-timer pinned): reverting the
 * deadline to enqueue-start fails that test. Kept separate because reliably forcing
 * the queue wait to exceed the bound here would require wall-clock timing the
 * desktop test:node determinism rule forbids — the bound is the only real timer, and
 * it is exactly what releases the poison turn, so the two can't be separated without
 * pinning the clock, which the helper test does.
 *
 * Synchronization is on real completion signals (the importSession mock's
 * `deferred()` and the runner's own dispatch signals). Exercised through stop() to
 * prove no healthy work is discarded when the pass is torn down.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import type { HistoricalParseRunner } from "../src/main/collectors/engine/historical-parse-runner.js";
import type { HistoricalParseResult } from "../src/main/collectors/engine/historical-parse-source.js";
import {
  createParseQuarantine,
  parseQuarantinePath,
} from "../src/main/collectors/engine/parse-quarantine.js";
import type {
  Harness,
  NormalizedSession,
} from "../src/main/collectors/types.js";
import type {
  Importer,
  ImportResult,
} from "../src/main/dashboard/agent-dashboard-db-types.js";
import { createWriteQueue } from "../src/main/database/write-queue.js";
import { deferred } from "./deferred.js";
import { fakeCollector, makeSession } from "./normalized-session-test-utils.js";

// A tiny parse bound keeps the test fast: the poison parse never settles, so the
// only way the loop advances past it is via the timeout path.
const TEST_PARSE_TIMEOUT_MS = 40;
const TEST_IMPORT_TIMEOUT_MS = 40;
// Explicit per-test timeout: these integration tests use the manager's REAL
// per-source watchdog (the tiny bound above) as the only real timer, so they must
// carry their own `node:test` timeout rather than lean on the runner default —
// a regression that never releases the poison/wedged turn fails fast here instead
// of hanging (apps/desktop AGENTS.md test:node determinism rule).
const TEST_CASE_TIMEOUT_MS = 15_000;

async function noopCooperativeDelay(): Promise<void> {
  // No pacing pauses — keep the import loop tight for the test.
}

/**
 * A runner that reproduces the production utility-process runner's contract: a
 * SERIALIZED dispatch tail (one request in flight at a time across every harness
 * loop) that fires `onDispatch` ONLY when a request is actually posted to the
 * worker — past the queue wait. A poison source's parse never settles and is
 * abandoned when the manager's deadline aborts it; the next queued source then
 * dispatches on a fresh turn. This is exactly the serialization the real runner's
 * `dispatchTail` + worker kill provide, minus the Electron utility process.
 */
function createSerializedFakeRunner(
  parseBody: (
    collectorKey: Harness,
    source: string
  ) => Promise<NormalizedSession[]>,
  opts: {
    /**
     * ISS-4572 flake fix: optional per-source enqueue gate. The five harness
     * boot loops start concurrently, so WITHOUT a gate the relative order in
     * which their sources join the shared tail is scheduler luck — R1's
     * two-poison premise (healthy queues behind BOTH poison turns) held only
     * when the interleaving happened to land [A, B, healthy], and the CI
     * runner sometimes landed [A, healthy, B], where stop() tears down before
     * B ever dispatches. Returning a promise here holds that source's request
     * OFF the tail until a real dispatch signal fires (no wall-clock waits —
     * the desktop test:node determinism rule). Undefined = enqueue
     * immediately, the prior behavior.
     */
    holdUntil?: (source: string) => Promise<void> | undefined;
  } = {}
): HistoricalParseRunner & { dispatchedSources: string[] } {
  const dispatchedSources: string[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  let abortActive: (() => void) | null = null;

  const dispatchParse = (
    collectorKey: Harness,
    source: string,
    onDispatch?: () => void
  ): Promise<HistoricalParseResult> => {
    // Signal DISPATCH the instant this request reaches the worker — after the
    // shared tail drained — mirroring the production runner's post-to-worker hook.
    dispatchedSources.push(source);
    onDispatch?.();
    return new Promise<HistoricalParseResult>((resolve, reject) => {
      let settled = false;
      // The manager's abort hook (per-source watchdog) rejects this turn so the
      // serialized tail advances and the next source dispatches — exactly what
      // killing the worker child does in production.
      abortActive = () => {
        if (settled) {
          return;
        }
        settled = true;
        abortActive = null;
        reject(new Error("historical parse worker aborted (test)"));
      };
      parseBody(collectorKey, source).then(
        (sessions) => {
          if (!settled) {
            settled = true;
            abortActive = null;
            // ISS-5266: the runner resolves with the parse RESULT; this fake
            // carries no side-report, which is the non-OpenCode shape.
            resolve({ sessions });
          }
        },
        (error) => {
          if (!settled) {
            settled = true;
            abortActive = null;
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      );
    });
  };

  const joinTail = (
    collectorKey: Harness,
    source: string,
    onDispatch?: () => void
  ): Promise<HistoricalParseResult> => {
    const result = tail.then(
      () => dispatchParse(collectorKey, source, onDispatch),
      () => dispatchParse(collectorKey, source, onDispatch)
    );
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  return {
    dispatchedSources,
    parseSource(collectorKey, source, onDispatch) {
      const gate = opts.holdUntil?.(source);
      if (!gate) {
        return joinTail(collectorKey, source, onDispatch);
      }
      // Join the tail only AFTER the gate opens, so the held source's turn is
      // ordered behind every turn enqueued while it waited.
      return gate.then(() => joinTail(collectorKey, source, onDispatch));
    },
    stop() {
      abortActive?.();
    },
    abortInFlightParse() {
      abortActive?.();
    },
  };
}

test("ISS-4572 (R1): a source that waited behind a poison parse does not charge the queue wait to its own bound and records NO spurious quarantine", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-4572-r1-"));
  // TWO poison sources on the poison harness: the healthy source waits behind BOTH
  // of them on the shared serialized runner, so its queue wait spans ~2 parse-bound
  // windows. That makes the mutation deterministic: with an enqueue-scoped deadline
  // the healthy source's own bound (started at enqueue) would elapse DURING that
  // queue wait — well before it is ever dispatched — and record a spurious
  // quarantine. Dispatch-scoping starts its clock fresh only when it reaches the
  // worker, so it never does.
  const poisonSourceA = join(dir, "poison-a.jsonl");
  const poisonSourceB = join(dir, "poison-b.jsonl");
  const healthySource = join(dir, "healthy.jsonl");
  writeFileSync(poisonSourceA, "{}\n");
  writeFileSync(poisonSourceB, "{}\n");
  writeFileSync(healthySource, "{}\n");
  const mtime = new Date(2_000_000);
  utimesSync(poisonSourceA, mtime, mtime);
  utimesSync(poisonSourceB, mtime, mtime);
  utimesSync(healthySource, mtime, mtime);

  // Neither poison parse ever settles (the CPU-spin reproduction); each is aborted
  // by the manager's per-source watchdog in turn. The healthy parse resolves
  // cleanly — but ONLY once it is actually dispatched, which cannot happen until
  // both poison turns ahead of it are aborted and the serialized tail advances.
  const poisonWedged = deferred<NormalizedSession[]>();
  const isPoison = (source: string): boolean =>
    source === poisonSourceA || source === poisonSourceB;
  // Deterministic ordering (flake fix): the healthy source may not even JOIN the
  // shared tail until poison-B has actually DISPATCHED. The boot loops start
  // concurrently, so without this gate the enqueue interleaving was scheduler
  // luck — when it landed [A, healthy, B], the healthy import resolved and
  // stop() tore down before B ever dispatched, failing the both-poisons sanity
  // assertion below. Gated on the runner's own dispatch signal (poison-B's
  // parseBody runs exactly at post-to-worker), never on wall-clock time. This
  // also makes the premise real in every run: the healthy queue wait always
  // spans poison-B's full parse-bound window.
  const poisonBDispatched = deferred();
  const runner = createSerializedFakeRunner(
    (_key, source) => {
      if (source === poisonSourceB) {
        poisonBDispatched.resolve();
      }
      return isPoison(source)
        ? poisonWedged.promise
        : Promise.resolve([makeSession({ sessionId: "healthy-session" })]);
    },
    {
      holdUntil: (source) =>
        source === healthySource ? poisonBDispatched.promise : undefined,
    }
  );

  const importedSessions: string[] = [];
  const healthyImported = deferred();

  try {
    const manager = new CollectorManager({
      importer: {
        importSession: (session) => {
          importedSessions.push(session.sessionId);
          if (session.sessionId === "healthy-session") {
            healthyImported.resolve();
          }
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      // One state dir; each harness's quarantine file is keyed by collector name
      // (`parseQuarantinePath(stateDir, name)`), so the two are independently
      // assertable from the same directory.
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalParseRunner: runner,
      historicalParseTimeoutMs: TEST_PARSE_TIMEOUT_MS,
      parseQuarantineMaxAttempts: 1,
      collectors: [
        // Poison harness (claude): both sources parse forever and ARE expected to
        // be dead-lettered/quarantined — that is not the assertion under test.
        fakeCollector("claude", {
          sources: [poisonSourceA, poisonSourceB],
          sessionIdForSource: (source) =>
            source === poisonSourceA ? "poison-a" : "poison-b",
          parse: () => poisonWedged.promise,
        }),
        // Healthy harness (codex): its source parses fine, but only AFTER waiting
        // behind the poison parse on the shared serialized runner. It must not
        // record a spurious quarantine for that queue wait.
        fakeCollector("codex", {
          sources: [healthySource],
          sessionIdForSource: () => "healthy-session",
          parse: () =>
            Promise.resolve([makeSession({ sessionId: "healthy-session" })]),
        }),
      ],
    });

    manager.start();
    // The healthy source must import despite waiting behind the poison parse.
    await healthyImported.promise;
    manager.stop();
    poisonWedged.resolve([]); // let the abandoned poison parse settle harmlessly

    assert.ok(
      importedSessions.includes("healthy-session"),
      "the healthy source imported after the poison parse was dead-lettered"
    );

    // R1 assertion: the healthy harness recorded NO quarantine attempt. With an
    // enqueue-scoped deadline the healthy source would have timed out during the
    // queue wait and recorded a spurious attempt here (maxAttempts=1 ⇒ quarantined).
    const healthyQuarantine = createParseQuarantine({
      persistPath: parseQuarantinePath(dir, "codex"),
      maxAttempts: 1,
    });
    assert.equal(
      healthyQuarantine.quarantinedCount(),
      0,
      "the healthy source recorded NO spurious quarantine for its queue wait (deadline is dispatch-scoped)"
    );

    // Sanity: both poison sources WERE dispatched ahead of the healthy one (so it
    // genuinely queued behind real in-flight turns, not a no-op), and the healthy
    // source dispatched only after them.
    assert.ok(
      runner.dispatchedSources.includes(poisonSourceA) &&
        runner.dispatchedSources.includes(poisonSourceB),
      "both poison sources were dispatched to the shared runner"
    );
    assert.ok(
      runner.dispatchedSources.indexOf(healthySource) >
        runner.dispatchedSources.indexOf(poisonSourceA),
      "the healthy source dispatched only after waiting behind the poison ones"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * R2 — a wedged db-host write is ACTIVELY EVICTED so later sources proceed.
 * Production-shaped through the real `CollectorManager` + the real single-writer
 * `createWriteQueue`: the importer routes each session's write through the ONE
 * queue TAGGED with the session id and wires `cancelInFlightWrite` to the queue's
 * TASK-SCOPED eviction, just like `openSqliteAgentDatabase`. A poison source's
 * write is accepted but never completes, parking it at the queue head; a later
 * source's write is queued behind it. `importSessionBounded` times out, evicts the
 * wedged session's own task by id, and the later source's write dispatches and
 * completes.
 *
 * Split-write safety (R2, codex/stage T1/T3): the queue TAIL advances only when
 * the evicted task's underlying write TRULY settles — never on the early caller
 * rejection — so the later source's transaction cannot open on the single writer
 * connection while the abandoned one may still be mid-flight. This test models
 * that faithfully: the wedged write unwinds (settles) as a CONSEQUENCE of the
 * eviction (in DB-host mode the eviction is what lets the child abandon its queue
 * task), and only THEN does the later write dispatch.
 *
 * MUTATION: removing the eviction (stubbing `cancelInFlightWrite` to a no-op) never
 * unwinds the wedged write, so it never settles, the tail never advances, the later
 * source's write stays parked, `laterWriteRan` never resolves, and the `node:test`
 * timeout fails this test fast.
 *
 * Synchronization is on a COMPLETION SIGNAL, not a poll: `importSession` controls
 * the exact point the later write starts, so it resolves a `deferred` there and the
 * test awaits it (apps/desktop AGENTS.md test:node determinism rule — wongk review).
 */
test("ISS-4572 (R2): a wedged db-host write is evicted so a later source's write proceeds (not parked)", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-4572-r2-"));
  const wedgedSource = join(dir, "wedged.jsonl");
  const laterSource = join(dir, "later.jsonl");
  writeFileSync(wedgedSource, "{}\n");
  writeFileSync(laterSource, "{}\n");
  // Process the wedged source first (newest mtime) — it is the "stuck at 1/N" head.
  utimesSync(laterSource, new Date(1_000_000), new Date(1_000_000));
  utimesSync(wedgedSource, new Date(2_000_000), new Date(2_000_000));

  // The REAL single-writer queue. The wedged session's write is enqueued and stays
  // in-flight until its OWN task is evicted; the later session's write is enqueued
  // behind it and, for split-write safety, can only run once the abandoned write
  // truly settles.
  const queue = createWriteQueue();
  const wedgedWrite = deferred<void>();
  // Completion signal: resolved by `importSession` the instant the later source's
  // write actually runs — the exact point the test cares about.
  const laterWriteRan = deferred<void>();

  const importer: Importer = {
    // TASK-SCOPED eviction. In DB-host mode the eviction is what lets the child
    // abandon its wedged queue task, so model that: evicting the wedged session's
    // task also unwinds (settles) its underlying write, which is what advances the
    // tail. A no-op stub (the mutation) never unwinds it → the later write parks
    // forever → the test times out.
    cancelInFlightWrite: (sessionId, reason) => {
      const evicted = queue.cancel(sessionId, reason);
      if (evicted && sessionId === "wedged-session") {
        wedgedWrite.resolve();
      }
      return evicted;
    },
    importSession: (session): Promise<ImportResult> =>
      queue.run(async () => {
        if (session.sessionId === "wedged-session") {
          await wedgedWrite.promise; // in-flight until its task is evicted
          return { skipped: false, reactivated: false };
        }
        laterWriteRan.resolve();
        return { skipped: false, reactivated: false };
      }, session.sessionId),
  };

  try {
    const manager = new CollectorManager({
      importer,
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalImportSessionTimeoutMs: TEST_IMPORT_TIMEOUT_MS,
      collectors: [
        fakeCollector("claude", {
          sources: [wedgedSource, laterSource],
          sessionIdForSource: (source) =>
            source === wedgedSource ? "wedged-session" : "later-session",
          parse: (source) =>
            Promise.resolve([
              makeSession({
                sessionId:
                  source === wedgedSource ? "wedged-session" : "later-session",
              }),
            ]),
        }),
      ],
    });

    manager.start();
    // The later source's write runs only if the wedged head is evicted off the
    // shared queue. Await the completion signal `importSession` resolves the moment
    // that write runs — the `node:test` timeout above bounds it, so the mutation
    // (removing the eviction, which parks the later write forever) fails this test
    // fast instead of hanging.
    await laterWriteRan.promise;
    manager.stop();
    wedgedWrite.resolve(); // idempotent: already resolved by the eviction
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

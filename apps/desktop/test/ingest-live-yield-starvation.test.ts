/**
 * @file ingest-live-yield-starvation.test.ts
 * @description ISS-5028 regression: the first-launch historical backfill must
 * not be starved by live watcher events.
 *
 * The low-duty pass yields to live events whenever the watcher's predicate
 * (`pendingEvents.length > 0`) is true. With no minimum work quantum, a SINGLE
 * queued filesystem event parked the pass after one source — and because the
 * harness being imported (Claude Code) is the same tool actively writing new
 * session transcripts, the queue was never empty and the pass never completed.
 * The operator report was 67 sources oscillating between 67 and 68 pending for
 * 15+ minutes, with the sibling Codex harness (no competing writer) finishing
 * its 6 sources in 18s.
 *
 * The case below reproduces exactly that shape: an event queue that never
 * drains (a fresh watcher event is emitted on every session import) plus a
 * source population that grows by one file on every resume. Pre-fix the pass
 * completed one source per resume while gaining one, so it never converged;
 * post-fix the ISS-5028 quantum floor amortizes each resume over
 * MIN_SOURCES_PER_LIVE_YIELD_QUANTUM sources and the pass finishes within a
 * bounded number of resumes.
 *
 * Determinism: the adversary is disarmed after ADVERSARY_RESUMES resumes, so a
 * regression fails on the resume-count assertion rather than hanging.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import {
  BatchResumeCursors,
  MAX_SESSION_IDS_PER_SOURCE,
} from "../src/main/collectors/engine/collector-manager-batch-resume.js";
import {
  createLiveYieldGate,
  MAX_MS_PER_LIVE_YIELD_QUANTUM,
  MIN_SESSIONS_PER_LIVE_YIELD_QUANTUM,
  MIN_SOURCES_PER_LIVE_YIELD_QUANTUM,
} from "../src/main/collectors/engine/collector-manager-low-duty-pacing.js";
import { ingestBatchResumeCursorPath } from "../src/main/collectors/engine/ingest-paths.js";
import type { HarnessCollector } from "../src/main/collectors/types.js";
import { InvalidTokenCountError } from "../src/main/cost/token-counts.js";
import { deferred } from "./deferred.js";
import {
  fakeFsWatcher,
  noopCooperativeDelay,
} from "./helpers/collector-manager-fixtures.js";
import { fakeCollector, makeSession } from "./normalized-session-test-utils.js";

// Enough sources that a one-source-per-resume pass is clearly distinguishable
// from a quantum-floored one, while staying small enough to run fast.
const SOURCE_COUNT = 12;
// After this many resumes the adversary stops emitting events and stops growing
// the source set, so a starved pass still terminates and fails a bounded
// assertion instead of hanging the suite.
const ADVERSARY_RESUMES = 6;
// The bound under test. `listSources` runs exactly once per historical pass
// entry, so counting its calls IS counting resumes. With the ISS-5028 floor of
// 10, one quantum clears 10 of the 12 and the next clears the remaining 2 plus
// whatever grew while parked: 2 entries, so 3 leaves a little slack. Pre-fix
// this run took 7 entries and imported exactly ONE source in each of the first
// six — the starvation signature.
const MAX_EXPECTED_ENTRIES = 3;
// thadeusb review: the CollectorManager cases below await a convergence signal
// (`onBootImportComplete`) that a regression can simply never produce, so they
// must carry their own `node:test` timeout rather than lean on the runner
// default — a manager that never converges then fails fast instead of hanging
// the whole suite (apps/desktop AGENTS.md test:node determinism rule). Sized to
// match the sibling CollectorManager integration suites in this directory.
const TEST_CASE_TIMEOUT_MS = 15_000;

test("ISS-5028: a never-draining live-event queue cannot starve the first backfill pass", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5028-live-yield-starvation-"));
  // A file the harness "keeps writing" — the live watcher event the pass yields
  // to. It is deliberately NOT in the historical source list; its only job is to
  // keep `pendingEvents` non-empty for the whole pass.
  const liveFile = "live-activity.jsonl";
  writeFileSync(join(dir, liveFile), "{}\n");

  const sources: string[] = [];
  for (let index = 0; index < SOURCE_COUNT; index += 1) {
    const source = join(dir, `history-${index}.jsonl`);
    writeFileSync(source, "{}\n");
    sources.push(source);
  }

  const lines: string[] = [];
  const bootComplete = deferred();
  let listSourcesCalls = 0;
  let grown = 0;
  let emitWatcherEvent: ((filename: string) => void) | null = null;
  const adversaryArmed = () => listSourcesCalls <= ADVERSARY_RESUMES;

  try {
    const base = fakeCollector("claude", {
      sources,
      watchRoots: [dir],
      sessionIdForSource: (source) => `session-${source}`,
      parse: (source) =>
        Promise.resolve([makeSession({ sessionId: `session-${source}` })]),
    });
    const collector: HarnessCollector = {
      ...base,
      listSources: () => {
        listSourcesCalls += 1;
        // Every RESUME finds the population grown: new Claude Code transcripts
        // landed while the pass was parked. This is the reported 67 → 68.
        if (listSourcesCalls > 1 && adversaryArmed()) {
          const source = join(dir, `grown-${grown++}.jsonl`);
          writeFileSync(source, "{}\n");
          sources.push(source);
        }
        return [...sources];
      },
    };

    const manager = new CollectorManager({
      importer: {
        importSession: () => {
          // The harness is still running: every import is racing a fresh
          // transcript write, so the watcher queue refills immediately.
          if (adversaryArmed()) {
            emitWatcherEvent?.(liveFile);
          }
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      catchupPollMs: null,
      log: (message) => lines.push(message),
      onBootImportComplete: () => bootComplete.resolve(),
      watchDirectory: (_root, listener) => {
        emitWatcherEvent = (filename) => listener("change", filename);
        return fakeFsWatcher();
      },
      collectors: [collector],
    });

    manager.start();
    await bootComplete.promise;
    manager.stop();

    assert.ok(
      listSourcesCalls <= MAX_EXPECTED_ENTRIES,
      `the pass must converge within ${MAX_EXPECTED_ENTRIES} resumes, took ${listSourcesCalls}: ${JSON.stringify(lines)}`
    );
    assert.ok(
      lines.some((line) =>
        line.includes("session backfill [claude] first pass complete")
      ),
      `the first pass must complete: ${JSON.stringify(lines)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-5028: the yield gate holds a low-duty pass until its quantum is met", () => {
  const gate = createLiveYieldGate(true, () => true, 3);

  assert.equal(gate.shouldYield(), false, "no source completed yet");
  gate.noteSourceCompleted();
  gate.noteSourceCompleted();
  assert.equal(gate.shouldYield(), false, "still under the floor");
  gate.noteSourceCompleted();
  assert.equal(gate.shouldYield(), true, "the quantum is met");
  assert.equal(gate.sourcesThisQuantum(), 3);
});

test("ISS-5028: a live-watcher import never yields, and an absent predicate never yields", () => {
  const liveImport = createLiveYieldGate(false, () => true, 1);
  liveImport.noteSourceCompleted();
  assert.equal(liveImport.shouldYield(), false);

  const noPredicate = createLiveYieldGate(true, undefined, 1);
  noPredicate.noteSourceCompleted();
  assert.equal(noPredicate.shouldYield(), false);
});

test("ISS-5028: the quantum is also met by elapsed time, so a slow or batch source still yields", () => {
  // The source floor alone is not a bound on how long a live event waits, and
  // for a BATCH harness (OpenCode: one store sentinel for the whole corpus) it
  // is not a bound at all — `completed` never leaves 0, so without the time
  // escape both yield sites would be permanently unreachable.
  let nowMs = 1000;
  const gate = createLiveYieldGate(
    true,
    () => true,
    MIN_SOURCES_PER_LIVE_YIELD_QUANTUM,
    MAX_MS_PER_LIVE_YIELD_QUANTUM,
    () => nowMs
  );

  assert.equal(gate.shouldYield(), false, "no work done yet");
  nowMs += MAX_MS_PER_LIVE_YIELD_QUANTUM - 1;
  assert.equal(
    gate.shouldYield(),
    false,
    "still inside the time escape, and no source has completed"
  );

  nowMs += 1;
  assert.equal(
    gate.shouldYield(),
    true,
    "the time escape opens the gate with zero completed sources (the batch-harness shape)"
  );
  assert.equal(
    gate.sourcesThisQuantum(),
    0,
    "the escape fired on elapsed time, not on source count"
  );
});

test("ISS-5028: the time escape never overrides a quiet event queue", () => {
  let nowMs = 0;
  const gate = createLiveYieldGate(
    true,
    () => false,
    MIN_SOURCES_PER_LIVE_YIELD_QUANTUM,
    MAX_MS_PER_LIVE_YIELD_QUANTUM,
    () => nowMs
  );

  nowMs = MAX_MS_PER_LIVE_YIELD_QUANTUM * 10;
  assert.equal(
    gate.shouldYield(),
    false,
    "the quantum only permits a yield; the watcher predicate still decides"
  );
});

test("ISS-5028: a quiet event queue still never yields, whatever the quantum", () => {
  const gate = createLiveYieldGate(true, () => false);

  for (let index = 0; index < MIN_SOURCES_PER_LIVE_YIELD_QUANTUM + 1; index++) {
    gate.noteSourceCompleted();
  }

  assert.equal(gate.shouldYield(), false);
});

// ISS-5028 (wongk review): the two yield sites are NOT equivalent. A source
// boundary has a checkpoint (the source is marked/committed, so the resume skips
// it); a mid-source yield has none, so the resumed pass re-lists, re-scans and
// re-parses the whole source. Letting elapsed time open that site would make a
// store whose parse alone approaches the quantum yield after one session on
// every resume and never finish.
test("ISS-5028: the mid-source gate takes only the durable-session floor", () => {
  let nowMs = 1000;
  const gate = createLiveYieldGate(
    true,
    () => true,
    2,
    5000,
    () => nowMs,
    3
  );

  gate.noteSourceCompleted();
  gate.noteSourceCompleted();
  nowMs += 5000;
  assert.equal(
    gate.shouldYield(),
    true,
    "the checkpointed site is open on sources and elapsed work"
  );
  assert.equal(
    gate.shouldYieldMidSource(),
    false,
    "neither term reaches the site with no checkpoint"
  );

  gate.noteSessionImported();
  gate.noteSessionImported();
  assert.equal(
    gate.shouldYieldMidSource(),
    false,
    "still under the durable-session floor"
  );
  gate.noteSessionImported();
  assert.equal(gate.shouldYieldMidSource(), true, "the session quantum is met");
  assert.equal(gate.sessionsThisQuantum(), 3);
});

test("ISS-5028: a live-watcher import never yields mid-source either", () => {
  const liveImport = createLiveYieldGate(
    false,
    () => true,
    1,
    1000,
    Date.now,
    1
  );
  liveImport.noteSessionImported();
  assert.equal(liveImport.shouldYieldMidSource(), false);
});

// ISS-5028 (bot review): the user can PAUSE the backfill from the import banner,
// and that park happens inside the loop this gate paces. Counting it as quantum
// time would leave the gate already open after any pause longer than one
// quantum, so the pass yields after a single source and pays a full re-scan for
// it — this module's own starvation, reached through the pause button.
test("ISS-5028: time parked at the user's backfill pause is not time spent working", () => {
  let nowMs = 0;
  const quantumMs = 1000;
  const gate = createLiveYieldGate(
    true,
    () => true,
    10,
    quantumMs,
    () => nowMs
  );

  gate.noteParked();
  nowMs += quantumMs * 10;
  assert.equal(
    gate.workingMsThisQuantum(),
    0,
    "a parked pass has done no work, however long it sat there"
  );
  assert.equal(
    gate.shouldYield(),
    false,
    "the time escape must not be open the instant the user resumes"
  );

  gate.noteUnparked();
  nowMs += quantumMs - 1;
  assert.equal(gate.workingMsThisQuantum(), quantumMs - 1);
  assert.equal(gate.shouldYield(), false, "still inside the quantum");
  nowMs += 1;
  assert.equal(gate.shouldYield(), true, "a full quantum of real work");
});

test("ISS-5028: an unmatched unpark cannot rewind the quantum clock", () => {
  let nowMs = 0;
  const gate = createLiveYieldGate(
    true,
    () => true,
    10,
    1000,
    () => nowMs
  );

  nowMs += 5000;
  gate.noteUnparked();
  assert.equal(
    gate.workingMsThisQuantum(),
    5000,
    "unparking without a park discounts nothing"
  );
  gate.noteParked();
  gate.noteParked();
  nowMs += 5000;
  gate.noteUnparked();
  assert.equal(
    gate.workingMsThisQuantum(),
    5000,
    "a re-entrant park still discounts the interval exactly once"
  );
});

// ISS-5028 (wongk review): the checkpoint a mid-source yield needs. Keyed on
// SESSION IDENTITY (a snapshot key is invalidated by the very writes that cause
// the yield) and dropped at the source's terminal outcome, so it can only ever
// fast-forward between two quanta of one uninterrupted source.
test("ISS-5028: the batch resume cursor is scoped per source and dropped on completion", () => {
  const cursors = new BatchResumeCursors();
  // ISS-5161 (review H2): the fingerprint gates EVERY cursor, in memory as well
  // as from disk — see `BatchResumeCursors.validateEntry`. This case is about
  // per-harness/per-source scoping and terminal-outcome cleanup, so it holds one
  // stable fingerprint to isolate those from the gate. The gate's own
  // memory-only behavior (dropped when the store moves, pre-move ids never
  // revived by a later record, still fast-forwarding while unmoved) is pinned in
  // `ingest-batch-resume-cursor-store.test.ts`.
  const fp = "opencode.db:1000:512";

  cursors.noteImported("opencode", "/store.db", "s1", fp);
  assert.equal(cursors.isImported("opencode", "/store.db", "s1", fp), true);
  assert.equal(cursors.isImported("opencode", "/store.db", "s2", fp), false);
  assert.equal(
    cursors.isImported("claude", "/store.db", "s1", fp),
    false,
    "cursors do not leak across harnesses"
  );
  assert.equal(
    cursors.isImported("opencode", "/other.db", "s1", fp),
    false,
    "nor across sources of the same harness"
  );

  cursors.noteImported("opencode", "/store.db", "s2", fp);
  assert.equal(cursors.isImported("opencode", "/store.db", "s2", fp), true);

  // The source reached a terminal outcome: a later retry must re-read every
  // session, or an append that landed after the first import is skipped forever.
  cursors.forget("opencode", "/store.db");
  assert.equal(cursors.isImported("opencode", "/store.db", "s1", fp), false);
  assert.equal(cursors.isImported("opencode", "/store.db", "s2", fp), false);

  cursors.noteImported("opencode", "/store.db", "s3", fp);
  cursors.clear();
  assert.equal(cursors.isImported("opencode", "/store.db", "s3", fp), false);
});

// wongk review (ISS-5028): "cover repeated timed yields through CollectorManager;
// the gate-only test cannot catch this." A BATCH harness is one source holding
// the whole corpus, so a mid-source yield leaves nothing marked and the resumed
// pass re-parses the store from session zero. Without a resume cursor the pass
// re-imports the same prefix on every resume and never reaches new work — the
// ticket's non-convergence, one layer below the source loop.
const BATCH_SESSION_COUNT = MIN_SESSIONS_PER_LIVE_YIELD_QUANTUM * 2 + 50;
// 250 sessions at a 100-session mid-source quantum is 3 entries: 100, 100, 50.
const MAX_EXPECTED_BATCH_ENTRIES = 4;

test("ISS-5028: repeated mid-source yields walk forward through a batch store instead of replaying it", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5028-batch-resume-"));
  const store = join(dir, "opencode.db");
  writeFileSync(store, "{}\n");
  // The file the harness "keeps writing", so the watcher queue never drains
  // and the mid-source yield keeps being offered.
  const liveFile = "live-activity.jsonl";
  writeFileSync(join(dir, liveFile), "{}\n");

  const lines: string[] = [];
  const bootComplete = deferred();
  let listSourcesCalls = 0;
  let emitWatcherEvent: ((filename: string) => void) | null = null;
  // Disarmed after enough entries that a replaying regression still terminates
  // and fails the bounded assertion below rather than hanging.
  const adversaryArmed = () =>
    listSourcesCalls <= MAX_EXPECTED_BATCH_ENTRIES * 2;
  const importedIds: string[] = [];

  try {
    const base = fakeCollector("opencode", {
      batch: true,
      sources: [store],
      watchRoots: [dir],
      // Only the store holds sessions; a live event for `liveFile` maps to
      // itself and parses to nothing, so it cannot re-arm the adversary.
      parse: (source) =>
        Promise.resolve(
          source === store
            ? Array.from({ length: BATCH_SESSION_COUNT }, (_unused, index) =>
                makeSession({ sessionId: `batch-${index}` })
              )
            : []
        ),
    });
    const collector: HarnessCollector = {
      ...base,
      listSources: () => {
        listSourcesCalls += 1;
        return [store];
      },
      markSourceImported: () => true,
    };

    const manager = new CollectorManager({
      importer: {
        importSession: (session) => {
          importedIds.push(session.sessionId);
          if (adversaryArmed()) {
            emitWatcherEvent?.(liveFile);
          }
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      catchupPollMs: null,
      log: (message) => lines.push(message),
      onBootImportComplete: () => bootComplete.resolve(),
      watchDirectory: (_root, listener) => {
        emitWatcherEvent = (filename) => listener("change", filename);
        return fakeFsWatcher();
      },
      collectors: [collector],
    });

    manager.start();
    await bootComplete.promise;
    manager.stop();

    assert.ok(
      listSourcesCalls <= MAX_EXPECTED_BATCH_ENTRIES,
      `the batch store must converge within ${MAX_EXPECTED_BATCH_ENTRIES} entries, took ${listSourcesCalls}: ${JSON.stringify(lines)}`
    );
    // The cursor's whole point: every resume imports DIFFERENT sessions, so
    // each session is written exactly once across the pass. A replayed prefix
    // shows up here as a duplicate long before the entry bound trips.
    const historical = importedIds.filter((id) => id.startsWith("batch-"));
    assert.equal(
      new Set(historical).size,
      BATCH_SESSION_COUNT,
      "every session in the store must be imported"
    );
    assert.equal(
      historical.length,
      BATCH_SESSION_COUNT,
      `no session may be re-imported by a resumed quantum: ${historical.length} writes for ${BATCH_SESSION_COUNT} sessions`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// wongk review (ISS-5028): an error-only backlog used to `continue` past the
// shared yield check, so it could satisfy both the source floor and the time
// escape while watcher events sat queued.
test("ISS-5028: a backlog of failing sources still yields to queued live events", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5028-error-yield-"));
  const liveFile = "live-activity.jsonl";
  writeFileSync(join(dir, liveFile), "{}\n");
  const sources: string[] = [];
  // Two more than the source floor, so the gate opens with sources left.
  for (
    let index = 0;
    index < MIN_SOURCES_PER_LIVE_YIELD_QUANTUM + 2;
    index += 1
  ) {
    const source = join(dir, `history-${index}.jsonl`);
    writeFileSync(source, "{}\n");
    sources.push(source);
  }

  const lines: string[] = [];
  const bootComplete = deferred();
  let listSourcesCalls = 0;
  let emitWatcherEvent: ((filename: string) => void) | null = null;
  const parsed: string[] = [];

  try {
    const base = fakeCollector("claude", {
      sources,
      watchRoots: [dir],
      parse: (source) => {
        if (!sources.includes(source)) {
          return Promise.resolve([]);
        }
        parsed.push(source);
        // The harness is mid-turn on another transcript while this one fails.
        emitWatcherEvent?.(liveFile);
        // Terminal handling: the manager marks the source seen, so the pass
        // converges instead of retrying the same failure forever.
        return Promise.reject(new InvalidTokenCountError("inputTokens"));
      },
    });
    const collector: HarnessCollector = {
      ...base,
      listSources: () => {
        listSourcesCalls += 1;
        return [...sources];
      },
    };

    const manager = new CollectorManager({
      importer: {
        importSession: () => ({ skipped: false, reactivated: false }),
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      catchupPollMs: null,
      log: (message) => lines.push(message),
      onBootImportComplete: () => bootComplete.resolve(),
      watchDirectory: (_root, listener) => {
        emitWatcherEvent = (filename) => listener("change", filename);
        return fakeFsWatcher();
      },
      collectors: [collector],
    });

    manager.start();
    await bootComplete.promise;
    manager.stop();

    assert.ok(
      listSourcesCalls >= 2,
      `the failing backlog must return early for the queued live events, not run to the end of the pass: entries=${listSourcesCalls} ${JSON.stringify(lines)}`
    );
    // The yield must not cost correctness: every source is still attempted
    // exactly once across the pass, and the pass still completes.
    assert.deepEqual([...parsed].sort(), [...sources].sort());
    assert.ok(
      lines.some((line) =>
        line.includes("session backfill [claude] first pass complete")
      ),
      `the first pass must complete: ${JSON.stringify(lines)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * ISS-5161 (wongk review): the mid-source yield is only progress-preserving
 * while the resume cursor can RECORD what the quantum imported. Past
 * `MAX_SESSION_IDS_PER_SOURCE` it cannot, so a saturated cursor plus a
 * continuously pending live queue replays the same recorded prefix, re-imports
 * the same small unrecorded tail, and yields again before reaching anything
 * later — forever.
 *
 * The cursor is pre-saturated on disk with ids that are NOT in the store, so
 * nothing is fast-forwarded and every store session is genuinely new work that
 * the cursor then refuses to record. That is exactly the >100,100-session shape,
 * without materializing 100k sessions.
 */
test("ISS-5161: a saturated resume cursor stops yielding mid-source instead of starving forever", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5161-cursor-saturation-"));
  const store = join(dir, "opencode.db");
  writeFileSync(store, "{}\n");
  const liveFile = "live-activity.jsonl";
  writeFileSync(join(dir, liveFile), "{}\n");
  const fingerprint = "opencode.db:1000:512";

  // A cursor already at the cap for THIS source, under THIS fingerprint (a
  // disk-loaded entry is only honored when its fingerprint proves the store has
  // not moved). None of these ids exist in the store.
  writeFileSync(
    ingestBatchResumeCursorPath(dir),
    JSON.stringify({
      version: 2,
      cursors: {
        [`opencode ${store}`]: {
          fingerprint,
          sessionIds: Array.from(
            { length: MAX_SESSION_IDS_PER_SOURCE },
            (_unused, index) => `p${index}`
          ),
        },
      },
    })
  );

  const lines: string[] = [];
  const bootComplete = deferred();
  let listSourcesCalls = 0;
  let emitWatcherEvent: ((filename: string) => void) | null = null;
  const adversaryArmed = () =>
    listSourcesCalls <= MAX_EXPECTED_BATCH_ENTRIES * 2;
  const importedIds: string[] = [];

  try {
    const base = fakeCollector("opencode", {
      batch: true,
      sources: [store],
      watchRoots: [dir],
      parse: (source) =>
        Promise.resolve(
          source === store
            ? Array.from({ length: BATCH_SESSION_COUNT }, (_unused, index) =>
                makeSession({ sessionId: `batch-${index}` })
              )
            : []
        ),
    });
    const collector: HarnessCollector = {
      ...base,
      listSources: () => {
        listSourcesCalls += 1;
        return [store];
      },
      sourceFingerprint: () => fingerprint,
      markSourceImported: () => true,
    };

    const manager = new CollectorManager({
      importer: {
        importSession: (session) => {
          importedIds.push(session.sessionId);
          if (adversaryArmed()) {
            emitWatcherEvent?.(liveFile);
          }
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      catchupPollMs: null,
      log: (message) => lines.push(message),
      onBootImportComplete: () => bootComplete.resolve(),
      watchDirectory: (_root, listener) => {
        emitWatcherEvent = (filename) => listener("change", filename);
        return fakeFsWatcher();
      },
      collectors: [collector],
    });

    manager.start();
    await bootComplete.promise;
    manager.stop();

    const historical = importedIds.filter((id) => id.startsWith("batch-"));
    // The regression signature is a replayed prefix: with the mid-source yield
    // still armed on a saturated cursor, each resume re-imports from session
    // zero, so `historical.length` runs well past BATCH_SESSION_COUNT.
    assert.equal(
      historical.length,
      BATCH_SESSION_COUNT,
      `a saturated cursor must not replay the store on every resume: ${historical.length} writes for ${BATCH_SESSION_COUNT} sessions`
    );
    assert.equal(
      new Set(historical).size,
      BATCH_SESSION_COUNT,
      "every session in the store must still be imported"
    );
    assert.ok(
      listSourcesCalls <= MAX_EXPECTED_BATCH_ENTRIES,
      `the saturated source must converge within ${MAX_EXPECTED_BATCH_ENTRIES} entries, took ${listSourcesCalls}: ${JSON.stringify(lines)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @file catchup-cache.test.ts
 * @description Unit tests for the catchup cache, specifically verifying that
 * extraMtimeMs survives persist+reload (FEA-1459 Fix A).
 *
 * ISS-9838: the cache persists through an injected {@link IngestStorePort}
 * backed by SQLite rather than a JSON file, so these drive it through the
 * in-memory port fake and assert on the snapshot it wrote back.
 */
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, test } from "vitest";
import { createCodexCollector } from "../src/main/collectors/codex/codex-collector.js";
import { readCodexRolloutLinkage } from "../src/main/collectors/codex/codex-subagent-rollouts.js";
import { createCatchupCache } from "../src/main/collectors/engine/catchup-cache.js";
import {
  createFailingIngestStore,
  createMemoryIngestStore,
} from "./ingest-store-test-utils.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

/**
 * The catchup-cache format version this suite expects to survive a reload.
 * Declared HERE, independently of the store's own `PERSIST_VERSION`, so the
 * discard test below fails if that constant is deleted or its comparison is
 * removed — a test that read its expectation from the constant it polices
 * could not.
 */
const CATCHUP_PERSIST_VERSION = 2;

afterEach(cleanupTempDirs);

test("catchup-cache: extraMtimeMs survives persist + reload", () => {
  const dir = makeTempDir("catchup-cache-test-");
  const store = createMemoryIngestStore();

  // Create a fake source file to stat.
  const sourceFile = path.join(dir, "session.jsonl");
  writeFileSync(sourceFile, "content\n", "utf8");

  // Phase 1: create cache, mark file seen with extraMtimeMs, flush.
  const cache1 = createCatchupCache({ store });
  const { stat } = cache1.isUnchanged(sourceFile);
  assert.ok(stat, "stat should be non-null for an existing file");
  cache1.markSeenWith(sourceFile, stat, 1_700_000_000_000);
  cache1.flush();
  assert.equal(
    store.peek()?.version,
    CATCHUP_PERSIST_VERSION,
    "the snapshot is stamped with the current format version"
  );

  // Phase 2: reload from the persisted snapshot — extraMtimeMs is restored.
  const cache2 = createCatchupCache({ store });

  // Same (mtime, size, extraMtime) → unchanged.
  const result = cache2.isUnchanged(sourceFile, 1_700_000_000_000);
  assert.equal(
    result.unchanged,
    true,
    "identical extraMtimeMs should be unchanged after reload"
  );

  // Newer extraMtime → changed (subagent file updated).
  const resultNewer = cache2.isUnchanged(sourceFile, 1_700_000_001_000);
  assert.equal(
    resultNewer.unchanged,
    false,
    "newer extraMtimeMs should be detected as changed"
  );

  // No extraMtime arg (non-subagent check) → unchanged (only mtime+size matter).
  const resultNoExtra = cache2.isUnchanged(sourceFile);
  assert.equal(
    resultNoExtra.unchanged,
    true,
    "no extraMtimeMs arg should still be unchanged"
  );
});

/**
 * ISS-12036: the no-session mark survives persist + reload, and is scoped to the
 * bytes it was recorded against.
 *
 * Durability is the whole point. A Codex root rollout the burst classifier drops
 * is re-listed by the orphan self-heal on EVERY launch, so a mark that lived
 * only in memory would hold for one process and the loop would resume on the
 * next — which is the shape ISS-12036 measured, 48h of a backfill that never
 * drained.
 *
 * MUTATION: drop the `noSession` branch from `parseSeenEntry` and the reloaded
 * cache forgets the mark; drop it from `markSeenWith` and nothing is persisted
 * to forget.
 */
test("catchup-cache: a no-session mark survives persist + reload and is keyed on the bytes", () => {
  const dir = makeTempDir("catchup-cache-no-session-");
  const store = createMemoryIngestStore();
  const sourceFile = path.join(dir, "rollout.jsonl");
  writeFileSync(sourceFile, "content\n", "utf8");

  const cache1 = createCatchupCache({ store });
  const { stat } = cache1.isUnchanged(sourceFile);
  assert.ok(stat);
  cache1.markSeenWith(sourceFile, stat, null, { yieldedNoSession: true });
  cache1.flush();

  const cache2 = createCatchupCache({ store });
  assert.deepEqual(
    (({ unchanged, yieldedNoSession }) => ({ unchanged, yieldedNoSession }))(
      cache2.isUnchanged(sourceFile)
    ),
    { unchanged: true, yieldedNoSession: true },
    "the mark is restored from the persisted snapshot"
  );

  // The exit: changed bytes drop the mark with the entry it rode on.
  appendFileSync(sourceFile, "more\n", "utf8");
  assert.deepEqual(
    (({ unchanged, yieldedNoSession }) => ({ unchanged, yieldedNoSession }))(
      cache2.isUnchanged(sourceFile)
    ),
    { unchanged: false, yieldedNoSession: false },
    "a changed transcript is offered again, with no mark to skip it"
  );

  // Re-marking a source that NOW yields a session clears the mark, because the
  // entry is rebuilt on every mark rather than merged into.
  const restat = cache2.isUnchanged(sourceFile).stat;
  assert.ok(restat);
  cache2.markSeenWith(sourceFile, restat);
  assert.equal(cache2.isUnchanged(sourceFile).yieldedNoSession, false);
});

/**
 * ISS-12036 (whitlockk review): the mark is also scoped to the collector's runtime
 * parse settings. Codex re-reads its burst thresholds on every parse, so a
 * raised record minimum can turn a dropped burst into a session with no change
 * to the file; the mark must stop skipping it then.
 */
test("catchup-cache: a no-session mark lapses when the zero-session parse key changes", () => {
  const dir = makeTempDir("catchup-cache-no-session-key-");
  const store = createMemoryIngestStore();
  const sourceFile = path.join(dir, "rollout.jsonl");
  writeFileSync(sourceFile, "content\n", "utf8");
  let parseKey = "burst:20:5000";

  const cache1 = createCatchupCache({
    store,
    zeroSessionParseKey: () => parseKey,
  });
  const { stat } = cache1.isUnchanged(sourceFile);
  cache1.markSeenWith(sourceFile, stat, null, { yieldedNoSession: true });
  cache1.flush();

  const cache2 = createCatchupCache({
    store,
    zeroSessionParseKey: () => parseKey,
  });
  assert.equal(cache2.isUnchanged(sourceFile).yieldedNoSession, true);

  parseKey = "burst:200:5000";
  const changed = cache2.isUnchanged(sourceFile);
  assert.equal(changed.unchanged, true, "the bytes did not move");
  assert.equal(
    changed.yieldedNoSession,
    false,
    "new burst settings: the zero no longer holds"
  );
});

test("codex collector's zero-session parse key follows the burst env vars", () => {
  const dir = makeTempDir("codex-zero-session-key-");
  const collector = createCodexCollector({
    sessionsDir: path.join(dir, "sessions"),
    archivedDir: path.join(dir, "archive"),
    listSources: () => [],
  });
  const before = collector.zeroSessionParseKey?.();

  const previous = process.env.SYMPHONY_CODEX_BURST_RECORD_MIN;
  process.env.SYMPHONY_CODEX_BURST_RECORD_MIN = "200";
  try {
    assert.ok(before);
    assert.notEqual(collector.zeroSessionParseKey?.(), before);
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "SYMPHONY_CODEX_BURST_RECORD_MIN");
    } else {
      process.env.SYMPHONY_CODEX_BURST_RECORD_MIN = previous;
    }
  }
});

test("catchup-cache: load without extraMtimeMs (absent in persisted data) works", () => {
  const dir = makeTempDir("catchup-cache-test-");
  const store = createMemoryIngestStore();

  // Create a fake source file.
  const sourceFile = path.join(dir, "session.jsonl");
  writeFileSync(sourceFile, "content\n", "utf8");

  // Phase 1: mark seen WITHOUT extraMtimeMs.
  const cache1 = createCatchupCache({ store });
  cache1.markSeen(sourceFile);
  cache1.flush();

  // Phase 2: reload — should work fine without extraMtimeMs.
  const cache2 = createCatchupCache({ store });
  const result = cache2.isUnchanged(sourceFile);
  assert.equal(result.unchanged, true, "basic mtime+size check still works");

  // Passing extraMtime triggers the "newer than cached 0" check.
  const resultWithExtra = cache2.isUnchanged(sourceFile, 1);
  assert.equal(
    resultWithExtra.unchanged,
    false,
    "any extraMtimeMs > 0 flags as changed when none was persisted"
  );
});

test("catchup-cache: persisted cache from an older PERSIST_VERSION is discarded", () => {
  // PR #1511 review (P1): a version-1 cache written by the pre-FEA-1459
  // pipeline must not let unchanged historical transcripts skip the new
  // dedup/subagent/token_events parsing — stale-version entries are dropped
  // wholesale, forcing a one-time full reimport.
  const dir = makeTempDir("catchup-cache-test-");
  const store = createMemoryIngestStore();

  const sourceFile = path.join(dir, "session.jsonl");
  writeFileSync(sourceFile, "content\n", "utf8");

  // Simulate a snapshot at another version that already knows this exact
  // (mtime, size). ISS-9837 R3: the discard is WHOLE-STORE, so every entry goes
  // regardless of its own shape.
  const seeded = createCatchupCache({ store });
  seeded.markSeen(sourceFile);
  seeded.flush();
  const persisted = store.peek();
  assert.ok(persisted, "the seed flush persisted a snapshot");
  store.seed({
    version: CATCHUP_PERSIST_VERSION - 1,
    entries: persisted.entries,
  });

  // Reload: the older-version entries must be ignored — the file reads as
  // changed.
  const reloaded = createCatchupCache({ store });
  assert.equal(reloaded.size(), 0, "stale-version entries are discarded");
  const result = reloaded.isUnchanged(sourceFile);
  assert.equal(
    result.unchanged,
    false,
    "file must be reparsed after a PERSIST_VERSION bump"
  );

  // Current-version round-trip still works.
  reloaded.markSeen(sourceFile);
  reloaded.flush();
  const reloaded2 = createCatchupCache({ store });
  assert.equal(
    reloaded2.isUnchanged(sourceFile).unchanged,
    true,
    "current-version cache persists and reloads normally"
  );
});

test("catchup-cache: a snapshot from a FUTURE version is discarded too", () => {
  // ISS-9838: the discard is a version INEQUALITY, not "older than". A snapshot
  // written by a newer build that rolled back must not be read with this
  // build's entry semantics either.
  const dir = makeTempDir("catchup-cache-future-");
  const sourceFile = path.join(dir, "session.jsonl");
  writeFileSync(sourceFile, "content\n", "utf8");

  const store = createMemoryIngestStore();
  const seeded = createCatchupCache({ store });
  seeded.markSeen(sourceFile);
  seeded.flush();
  const persisted = store.peek();
  assert.ok(persisted, "the seed flush persisted a snapshot");
  store.seed({
    version: CATCHUP_PERSIST_VERSION + 1,
    entries: persisted.entries,
  });

  const reloaded = createCatchupCache({ store });
  assert.equal(reloaded.size(), 0, "future-version entries are discarded");
  assert.equal(
    reloaded.isUnchanged(sourceFile).unchanged,
    false,
    "the source must be reparsed rather than skipped on a foreign version"
  );
});

test("codex collector maps child watch events to parent and cache tracks descendant mtime", () => {
  const dir = makeTempDir("codex-catchup-cache-");
  const sessionsDir = path.join(dir, "sessions");
  const dayDir = path.join(sessionsDir, "2026", "06", "24");
  mkdirSync(dayDir, { recursive: true });
  const parentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const grandchildId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const parentPath = path.join(
    dayDir,
    `rollout-2026-06-24T10-00-00-${parentId}.jsonl`
  );
  const childPath = path.join(
    dayDir,
    `rollout-2026-06-24T10-01-00-${childId}.jsonl`
  );
  const grandchildPath = path.join(
    dayDir,
    `rollout-2026-06-24T10-02-00-${grandchildId}.jsonl`
  );
  writeFileSync(
    parentPath,
    `${JSON.stringify({
      timestamp: "2026-06-24T10:00:00.000Z",
      type: "session_meta",
      payload: { id: parentId, source: "exec" },
    })}\n`,
    "utf8"
  );
  writeFileSync(
    childPath,
    `${JSON.stringify({
      timestamp: "2026-06-24T10:01:00.000Z",
      type: "session_meta",
      payload: {
        id: childId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
              depth: 1,
            },
          },
        },
      },
    })}\n`,
    "utf8"
  );
  writeFileSync(
    grandchildPath,
    `${JSON.stringify({
      timestamp: "2026-06-24T10:02:00.000Z",
      type: "session_meta",
      payload: {
        id: grandchildId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: childId,
              depth: 2,
            },
          },
        },
      },
    })}\n${"x".repeat(128 * 1024)}\n`,
    "utf8"
  );
  const collector = createCodexCollector({
    sessionsDir,
    archivedDir: path.join(dir, "archive"),
    listSources: () => [parentPath, childPath, grandchildPath],
  });
  const cache = createCatchupCache({ store: createMemoryIngestStore() });

  const mapped = collector.sourcePathsForWatchEvent?.(
    sessionsDir,
    path.relative(sessionsDir, grandchildPath)
  );
  const firstExtraMtime = collector.extraMtime?.(parentPath) ?? null;
  const first = cache.isUnchanged(parentPath, firstExtraMtime);
  cache.markSeenWith(parentPath, first.stat, firstExtraMtime);
  cache.flush();

  assert.deepEqual(mapped, [parentPath]);
  assert.equal(cache.isUnchanged(parentPath, firstExtraMtime).unchanged, true);

  writeFileSync(
    grandchildPath,
    `${readFileSync(grandchildPath, "utf8")}\n`,
    "utf8"
  );
  const future = new Date(Date.now() + 5000);
  utimesSync(grandchildPath, future, future);
  const changedExtraMtime = collector.extraMtime?.(parentPath) ?? null;
  assert.equal(
    cache.isUnchanged(parentPath, changedExtraMtime).unchanged,
    false,
    "descendant mtime change should invalidate the cached parent"
  );
});

test("codex collector reuses prepared rollout metadata for per-source hooks", async () => {
  const dir = makeTempDir("codex-graph-cache-");
  const sessionsDir = path.join(dir, "sessions");
  const dayDir = path.join(sessionsDir, "2026", "06", "24");
  mkdirSync(dayDir, { recursive: true });
  const parentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const childId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const parentPath = path.join(
    dayDir,
    `rollout-2026-06-24T10-00-00-${parentId}.jsonl`
  );
  const childPath = path.join(
    dayDir,
    `rollout-2026-06-24T10-01-00-${childId}.jsonl`
  );
  writeFileSync(
    parentPath,
    `${JSON.stringify({
      timestamp: "2026-06-24T10:00:00.000Z",
      type: "session_meta",
      payload: { id: parentId, source: "exec" },
    })}\n`,
    "utf8"
  );
  writeFileSync(
    childPath,
    `${JSON.stringify({
      timestamp: "2026-06-24T10:01:00.000Z",
      type: "session_meta",
      payload: {
        id: childId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
              depth: 1,
            },
          },
        },
      },
    })}\n`,
    "utf8"
  );
  let listCalls = 0;
  const sources = [parentPath, childPath];
  const collector = createCodexCollector({
    sessionsDir,
    archivedDir: path.join(dir, "archive"),
    listSources: () => {
      listCalls++;
      return sources;
    },
  });

  await collector.prepareSourceBatch?.(sources);
  assert.equal(collector.isBurstArtifactSource?.(childPath), true);
  assert.equal(collector.extraMtime?.(parentPath) != null, true);
  assert.equal(collector.isBurstArtifactSource?.(childPath), true);

  assert.equal(
    listCalls,
    0,
    "prepared batch hooks must not rescan the source list"
  );
});

test("codex rollout classification reads only the bounded first-line prefix, not the whole transcript", () => {
  // Behavioral guard for the perf invariant that classification reads a bounded
  // metadata prefix (the first session_meta line) rather than full-reading and
  // splitting the entire transcript. The authoritative session_meta is line 1;
  // a CONFLICTING session_meta is buried past the bounded prefix behind >64KiB
  // of filler. A full-file read (readFileSync + split) would surface the decoy
  // and corrupt the linkage; a bounded first-line read must never see it.
  const dir = makeTempDir("codex-bounded-read-");
  const rolloutId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const realParent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const decoyParent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const rolloutPath = path.join(
    dir,
    `rollout-2026-06-24T10-00-00-${rolloutId}.jsonl`
  );

  const sessionMeta = (parentThreadId: string, depth: number): string =>
    JSON.stringify({
      timestamp: "2026-06-24T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: rolloutId,
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: parentThreadId, depth },
          },
        },
      },
    });

  // Filler well beyond MAX_CODEX_META_PREFIX_BYTES (64KiB) so the decoy meta
  // lands outside any bounded read.
  const filler =
    `${JSON.stringify({ type: "event", note: "x".repeat(512) })}\n`.repeat(300);
  writeFileSync(
    rolloutPath,
    `${sessionMeta(realParent, 2)}\n${filler}${sessionMeta(decoyParent, 9)}\n`,
    "utf8"
  );

  const linkage = readCodexRolloutLinkage(rolloutPath);

  assert.equal(
    linkage.parentThreadId,
    realParent,
    "linkage comes from the first-line session_meta"
  );
  assert.equal(linkage.depth, 2);
  assert.notEqual(
    linkage.parentThreadId,
    decoyParent,
    "the post-prefix session_meta must never be read"
  );
});

test("catchup-cache: with no store port the cache is memory-only and writes nothing", () => {
  // The engine constructs a cache with no store port for sources that have no
  // durable home to key off. That cache must still answer correctly for the
  // life of the process AND must not invent a file on disk — a stray cache
  // written next to a collector's data would be re-read as if it were the
  // collector's own state.
  const dir = makeTempDir("catchup-cache-memory-");
  const sourceFile = path.join(dir, "session.jsonl");
  writeFileSync(sourceFile, "content\n", "utf8");

  const cache = createCatchupCache();
  assert.equal(cache.persisted, false, "no store port means not persisted");
  cache.markSeen(sourceFile);
  assert.equal(
    cache.isUnchanged(sourceFile).unchanged,
    true,
    "the in-memory answer is still exact"
  );
  cache.flush();

  assert.deepEqual(
    readdirSync(dir),
    ["session.jsonl"],
    "flush() on a memory-only cache writes no file anywhere"
  );
  // ...and because nothing was written, a restart re-parses rather than
  // skipping: memory-only is honest about what it can promise.
  const rebuilt = createCatchupCache();
  assert.equal(rebuilt.size(), 0);
  assert.equal(rebuilt.isUnchanged(sourceFile).unchanged, false);
});

test("catchup-cache: a persisted entry that is not a (mtimeMs, size) pair is dropped, not trusted", () => {
  // The persisted payload is foreign JSON by the time it is re-read (an older
  // build, a hand-edit). An entry whose numbers are missing or are the wrong
  // type cannot be compared against a stat, and letting one through would make
  // `isUnchanged` answer from `undefined === stat.mtimeMs` — a silent SKIP of a
  // file that was never actually imported.
  const dir = makeTempDir("catchup-cache-malformed-");
  const goodFile = path.join(dir, "good.jsonl");
  writeFileSync(goodFile, "content\n", "utf8");

  const seedStore = createMemoryIngestStore();
  const seeded = createCatchupCache({ store: seedStore });
  seeded.markSeen(goodFile);
  seeded.flush();
  const goodEntry = seedStore.peek()?.entries[goodFile] as {
    mtimeMs: number;
    size: number;
  };

  const store = createMemoryIngestStore({
    version: CATCHUP_PERSIST_VERSION,
    entries: {
      [goodFile]: goodEntry,
      "/missing-size.jsonl": { mtimeMs: 1 },
      "/string-mtime.jsonl": { mtimeMs: "1", size: 2 },
      "/null-entry.jsonl": null,
      // A well-formed pair whose OPTIONAL extra mtime is unusable keeps the
      // entry and drops only that field — the subagent check then reads as
      // "no extra mtime seen" instead of discarding a valid stat pair.
      "/bad-extra.jsonl": { mtimeMs: 3, size: 4, extraMtimeMs: "nope" },
    },
  });

  const cache = createCatchupCache({ store });
  assert.equal(
    cache.size(),
    2,
    "only the two well-formed entries were restored"
  );
  assert.equal(
    cache.isUnchanged(goodFile).unchanged,
    true,
    "the well-formed entry still skips its file"
  );
  // Marking anything makes the cache dirty, so this flush rewrites the snapshot
  // from the RESTORED set — the malformed entries must not come back out.
  cache.markSeen(goodFile);
  cache.flush();
  const reloaded = store.peek();
  assert.ok(reloaded, "the flush wrote a snapshot back");
  assert.deepEqual(
    Object.keys(reloaded.entries).sort(),
    ["/bad-extra.jsonl", goodFile].sort(),
    "the malformed entries are gone rather than round-tripped back out"
  );
  assert.deepEqual(
    reloaded.entries["/bad-extra.jsonl"],
    { mtimeMs: 3, size: 4 },
    "the unusable extraMtimeMs was dropped, not persisted as a string"
  );
});

test("catchup-cache: markSeen on a path that cannot be stat'd records nothing", () => {
  // A file listed and then deleted before it is marked must not leave an entry
  // behind: a fabricated (mtime, size) would let a LATER file at that same path
  // be skipped as already-imported.
  const dir = makeTempDir("catchup-cache-unstattable-");
  const vanished = path.join(dir, "vanished.jsonl");

  const cache = createCatchupCache({ store: createMemoryIngestStore() });
  assert.doesNotThrow(() => cache.markSeen(vanished));
  assert.equal(cache.size(), 0, "no entry is invented for an unreadable path");

  // The file arrives later — it must still read as changed and be parsed.
  writeFileSync(vanished, "content\n", "utf8");
  assert.equal(cache.isUnchanged(vanished).unchanged, false);
});

test("catchup-cache: a refusing store port degrades to memory-only instead of failing the tick", () => {
  const dir = makeTempDir("catchup-cache-unwritable-");
  const sourceFile = path.join(dir, "session.jsonl");
  writeFileSync(sourceFile, "content\n", "utf8");
  // ISS-9838: the port that used to be an unwritable path is now one that
  // throws synchronously — the same un-stubbed failure on the persistence path.
  const store = createFailingIngestStore();

  const cache = createCatchupCache({ store });
  cache.markSeen(sourceFile);
  assert.doesNotThrow(
    () => cache.flush(),
    "a failed persist must never fail the import tick"
  );
  assert.equal(store.attempts(), 1, "the write was attempted and refused");
  // The reason swallowing is safe: the in-memory answer is unaffected, so this
  // process keeps skipping unchanged files. NOTE (ISS-5302): `flush()` clears
  // `dirty` BEFORE the write, so a later flush after the obstruction clears is
  // a no-op and the entry never lands — deliberate per the "best-effort
  // persistence" comment, and asserted here so a change to it is visible.
  assert.equal(cache.isUnchanged(sourceFile).unchanged, true);
  assert.equal(cache.size(), 1);
  cache.flush();
  assert.equal(
    store.attempts(),
    1,
    "the failed write is not retried on the next flush"
  );
});

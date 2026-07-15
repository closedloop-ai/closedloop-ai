/**
 * @file catchup-cache.test.ts
 * @description Unit tests for the catchup cache, specifically verifying that
 * extraMtimeMs survives persist+reload (FEA-1459 Fix A).
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createCodexCollector } from "../src/main/collectors/codex/codex-collector.js";
import { readCodexRolloutLinkage } from "../src/main/collectors/codex/codex-subagent-rollouts.js";
import { createCatchupCache } from "../src/main/collectors/engine/catchup-cache.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

test("catchup-cache: extraMtimeMs survives persist + reload", () => {
  const dir = makeTempDir("catchup-cache-test-");
  const persistPath = path.join(dir, "cache.json");

  // Create a fake source file to stat.
  const sourceFile = path.join(dir, "session.jsonl");
  writeFileSync(sourceFile, "content\n", "utf8");

  // Phase 1: create cache, mark file seen with extraMtimeMs, flush.
  const cache1 = createCatchupCache({ persistPath });
  const { stat } = cache1.isUnchanged(sourceFile);
  assert.ok(stat, "stat should be non-null for an existing file");
  cache1.markSeenWith(sourceFile, stat, 1_700_000_000_000);
  cache1.flush();

  // Phase 2: reload from disk — extraMtimeMs must be restored.
  const cache2 = createCatchupCache({ persistPath });

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

test("catchup-cache: load without extraMtimeMs (absent in persisted data) works", () => {
  const dir = makeTempDir("catchup-cache-test-");
  const persistPath = path.join(dir, "cache.json");

  // Create a fake source file.
  const sourceFile = path.join(dir, "session.jsonl");
  writeFileSync(sourceFile, "content\n", "utf8");

  // Phase 1: mark seen WITHOUT extraMtimeMs.
  const cache1 = createCatchupCache({ persistPath });
  cache1.markSeen(sourceFile);
  cache1.flush();

  // Phase 2: reload — should work fine without extraMtimeMs.
  const cache2 = createCatchupCache({ persistPath });
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
  const persistPath = path.join(dir, "cache.json");

  const sourceFile = path.join(dir, "session.jsonl");
  writeFileSync(sourceFile, "content\n", "utf8");

  // Simulate a v1 cache file that already knows this exact (mtime, size).
  const seeded = createCatchupCache({ persistPath });
  seeded.markSeen(sourceFile);
  seeded.flush();
  const onDisk = JSON.parse(readFileSync(persistPath, "utf8")) as {
    version: number;
    entries: Record<string, unknown>;
  };
  writeFileSync(
    persistPath,
    JSON.stringify({ version: 1, entries: onDisk.entries }),
    "utf8"
  );

  // Reload: the v1 entries must be ignored — the file reads as changed.
  const reloaded = createCatchupCache({ persistPath });
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
  const reloaded2 = createCatchupCache({ persistPath });
  assert.equal(
    reloaded2.isUnchanged(sourceFile).unchanged,
    true,
    "current-version cache persists and reloads normally"
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
  const cache = createCatchupCache({
    persistPath: path.join(dir, "catchup.json"),
  });

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

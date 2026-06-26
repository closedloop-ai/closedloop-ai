/**
 * @file catchup-cache.test.ts
 * @description Unit tests for the catchup cache, specifically verifying that
 * extraMtimeMs survives persist+reload (FEA-1459 Fix A).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCatchupCache } from "../src/main/collectors/catchup-cache.js";

test("catchup-cache: extraMtimeMs survives persist + reload", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "catchup-cache-test-"));
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "catchup-cache-test-"));
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "catchup-cache-test-"));
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

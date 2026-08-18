/**
 * @file codex-collector-surface.test.ts
 * @description Behavioral coverage for the Codex COLLECTOR's own surface
 * (`createCodexCollector` in `codex-collector.ts`) — its descriptor methods, the
 * persisted linkage cache (version/shape validation, staleness keying, pruning)
 * and the lazy graph lifecycle (ISS-5302).
 *
 * Split from `codex-collector-fold.test.ts`, which owns the descendant-FOLD
 * semantics (token projections, drops, provenance). These are collector
 * lifecycle and cache-durability concerns rather than fold semantics, and
 * keeping them apart keeps both files well clear of the 1,000-logical-line
 * ceiling root `AGENTS.md` sets. Every fixture is synthetic; nothing here reads
 * `packages/golden-sessions`.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createCodexCollector } from "../src/main/collectors/codex/codex-collector.js";
import {
  CODEX_CHILD_UUID,
  CODEX_PARENT_UUID,
  codexRolloutPath,
  codexSubagentMeta,
  minimalCodexRollout,
  writeCodexCollectorRollout,
} from "./codex-rollout-fixture.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

// Rollout ids that are never written to disk (dangling parents). Same length as
// the real ones, so a fixture rewrite stays byte-stable.
const ABSENT_PARENT_UUID = "99999999-9999-4999-8999-999999999999";
const ABSENT_PARENT_ALT_UUID = "88888888-8888-4888-8888-888888888888";
/** Fixed mtime for the staleness-key test, so two utimesSync calls agree. */
const PINNED_MTIME = new Date("2026-06-24T12:00:00.000Z");
/** Persisted linkage-cache format version the collector accepts. */
const LINKAGE_CACHE_VERSION = 1;

const ORIGINAL_TZ = process.env.TZ;

before(() => {
  process.env.TZ = "UTC";
});

after(() => {
  if (ORIGINAL_TZ === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
  return cleanupTempDirs();
});

/** Build a collector over an explicit source list rooted at `root`. */
function collectorOver(
  root: string,
  sources: string[],
  linkageCachePath?: string
) {
  return createCodexCollector({
    sessionsDir: root,
    archivedDir: path.join(root, "archive"),
    listSources: () => sources,
    linkageCachePath,
  });
}

/** Token totals the fixtures use unless a test asserts on specific numbers. */
const PARENT_TOTALS = { input: 100, cached: 0, output: 10 };
const CHILD_TOTALS = { input: 50, cached: 0, output: 5 };
const CHILD_TIMESTAMP = "2026-06-24T10:01:00.000Z";

/** A root rollout with one cumulative `token_count`, written under `root`. */
function writeParent(
  root: string,
  totals = PARENT_TOTALS,
  timestamp = "2026-06-24T10:00:00.000Z"
): string {
  return writeCodexCollectorRollout(
    root,
    CODEX_PARENT_UUID,
    minimalCodexRollout(CODEX_PARENT_UUID, timestamp, totals)
  );
}

/** A depth-1 subagent rollout of {@link writeParent}, written under `root`. */
function writeChild(
  root: string,
  lines: unknown[],
  prefix = "2026-06-24T10-01-00"
): string {
  return writeCodexCollectorRollout(root, CODEX_CHILD_UUID, lines, prefix);
}

/** The `minimalCodexRollout` lines for a depth-1 subagent of the parent. */
function childLines(
  timestamp = CHILD_TIMESTAMP,
  totals = CHILD_TOTALS,
  parentThreadId = CODEX_PARENT_UUID
): unknown[] {
  return minimalCodexRollout(
    CODEX_CHILD_UUID,
    timestamp,
    totals,
    codexSubagentMeta(timestamp, CODEX_CHILD_UUID, parentThreadId, 1)
  );
}

/** A well-formed persisted linkage-cache entry for `sourcePath`. */
function cacheEntry(
  sourcePath: string,
  linkage: Record<string, unknown>
): Record<string, unknown> {
  const stat = statSync(sourcePath);
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    linkage: {
      parentThreadId: null,
      depth: null,
      agentNickname: null,
      agentRole: null,
      forkedFromId: null,
      sourcePath,
      ...linkage,
    },
  };
}

/**
 * A structurally VALID entry for a source that is no longer on disk — the shape
 * the prune pass must drop. The stat fields are arbitrary: the file is gone, so
 * they can never be matched.
 */
function staleCacheEntry(sourcePath: string): Record<string, unknown> {
  return {
    mtimeMs: 1,
    size: 1,
    linkage: {
      rolloutId: ABSENT_PARENT_UUID,
      parentThreadId: null,
      depth: null,
      agentNickname: null,
      agentRole: null,
      forkedFromId: null,
      sourcePath,
    },
  };
}

function writeLinkageCache(
  cachePath: string,
  entries: Record<string, unknown>,
  version = LINKAGE_CACHE_VERSION
): void {
  writeFileSync(cachePath, JSON.stringify({ version, entries }), "utf8");
}

describe("Codex collector — descriptor surface", () => {
  test("resolves a rollout's session id from its source path", () => {
    const root = makeTempDir("codex-session-id-");
    const parentPath = writeParent(root);
    const collector = collectorOver(root, [parentPath]);

    assert.equal(collector.sessionIdForSource?.(parentPath), CODEX_PARENT_UUID);
  });

  test("reports no burst artifacts and no extra mtime when no rollouts exist", () => {
    // A fresh install: the graph cache never becomes non-empty, so every
    // accessor re-runs the lazy build rather than serving a stale empty graph.
    const root = makeTempDir("codex-empty-sources-");
    const orphan = codexRolloutPath(root, CODEX_PARENT_UUID);
    const collector = collectorOver(root, []);

    assert.equal(collector.isBurstArtifactSource?.(orphan), false);
    assert.equal(collector.extraMtime?.(orphan), null);
  });
});

describe("Codex collector — persisted linkage cache", () => {
  test("trusts a structurally valid cache entry instead of re-reading the rollout", async () => {
    const root = makeTempDir("codex-cache-hit-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, childLines());
    // The cached nickname deliberately differs from the one on disk
    // (`child-3333`), so the folded subagent's name proves which side won.
    const cachePath = path.join(root, "linkage-cache.json");
    writeLinkageCache(cachePath, {
      [childPath]: cacheEntry(childPath, {
        rolloutId: CODEX_CHILD_UUID,
        parentThreadId: CODEX_PARENT_UUID,
        depth: 1,
        agentNickname: "from-the-cache",
      }),
    });
    const collector = collectorOver(root, [parentPath, childPath], cachePath);

    const [parent] = await collector.parse(parentPath);

    assert.equal(parent.subagents?.length, 1);
    assert.equal(parent.subagents?.[0].name, "from-the-cache");
  });

  test("re-reads from disk when the cached stat no longer matches the file", async () => {
    const root = makeTempDir("codex-cache-stale-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, childLines());
    const cachePath = path.join(root, "linkage-cache.json");
    const entry = cacheEntry(childPath, {
      rolloutId: CODEX_CHILD_UUID,
      parentThreadId: CODEX_PARENT_UUID,
      depth: 1,
      agentNickname: "from-the-cache",
    });
    entry.size = (entry.size as number) + 1;
    writeLinkageCache(cachePath, { [childPath]: entry });
    const collector = collectorOver(root, [parentPath, childPath], cachePath);

    const [parent] = await collector.parse(parentPath);

    assert.equal(
      parent.subagents?.[0].name,
      `child-${CODEX_CHILD_UUID.slice(0, 4)}`,
      "the on-disk nickname wins over the stat-mismatched cache entry"
    );
  });

  for (const [label, entryFor] of rejectedCacheEntryCases()) {
    test(`rebuilds the graph from disk when the cache entry ${label}`, async () => {
      const root = makeTempDir("codex-cache-reject-");
      const parentPath = writeParent(root);
      const childPath = writeChild(root, childLines());
      const cachePath = path.join(root, "linkage-cache.json");
      writeLinkageCache(cachePath, { [childPath]: entryFor(childPath) });
      const collector = collectorOver(root, [parentPath, childPath], cachePath);

      const [parent] = await collector.parse(parentPath);

      // Rejected, not trusted and not fatal: the graph is rebuilt from disk, so
      // the child still folds with its real on-disk nickname.
      assert.equal(parent.subagents?.length, 1);
      assert.equal(
        parent.subagents?.[0].name,
        `child-${CODEX_CHILD_UUID.slice(0, 4)}`
      );
    });
  }

  test("ignores a cache file with an unknown version", async () => {
    const root = makeTempDir("codex-cache-version-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, childLines());
    const cachePath = path.join(root, "linkage-cache.json");
    writeLinkageCache(
      cachePath,
      {
        [childPath]: cacheEntry(childPath, {
          rolloutId: CODEX_CHILD_UUID,
          parentThreadId: CODEX_PARENT_UUID,
          depth: 1,
          agentNickname: "from-a-future-version",
        }),
      },
      LINKAGE_CACHE_VERSION + 1
    );
    const collector = collectorOver(root, [parentPath, childPath], cachePath);

    const [parent] = await collector.parse(parentPath);

    assert.equal(
      parent.subagents?.[0].name,
      `child-${CODEX_CHILD_UUID.slice(0, 4)}`
    );
    // ...and the collector rewrites the file at the version it does understand.
    const rewritten = JSON.parse(readFileSync(cachePath, "utf8")) as {
      version: number;
    };
    assert.equal(rewritten.version, LINKAGE_CACHE_VERSION);
  });

  test("ignores a corrupt cache file rather than failing the scan", async () => {
    const root = makeTempDir("codex-cache-corrupt-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, childLines());
    const cachePath = path.join(root, "linkage-cache.json");
    writeFileSync(cachePath, '{"version":1,"entries":{ truncated', "utf8");
    const collector = collectorOver(root, [parentPath, childPath], cachePath);

    const [parent] = await collector.parse(parentPath);

    assert.equal(parent.subagents?.length, 1);
    assert.equal(
      parent.subagents?.[0].name,
      `child-${CODEX_CHILD_UUID.slice(0, 4)}`
    );
  });

  test("prunes persisted entries whose source is gone, on the synchronous build", async () => {
    const root = makeTempDir("codex-cache-prune-sync-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, childLines());
    const cachePath = path.join(root, "linkage-cache.json");
    const stalePath = path.join(root, "2026", "06", "24", "rollout-gone.jsonl");
    writeLinkageCache(cachePath, {
      [parentPath]: cacheEntry(parentPath, { rolloutId: CODEX_PARENT_UUID }),
      [childPath]: cacheEntry(childPath, {
        rolloutId: CODEX_CHILD_UUID,
        parentThreadId: CODEX_PARENT_UUID,
        depth: 1,
      }),
      [stalePath]: staleCacheEntry(stalePath),
    });
    const collector = collectorOver(root, [parentPath, childPath], cachePath);

    await collector.parse(parentPath);

    assert.deepEqual(readCacheKeys(cachePath), [parentPath, childPath].sort());
  });

  test("prunes persisted entries whose source is gone, on the cooperative build", async () => {
    const root = makeTempDir("codex-cache-prune-async-");
    const parentPath = writeParent(root);
    const cachePath = path.join(root, "linkage-cache.json");
    const stalePath = path.join(root, "2026", "06", "24", "rollout-gone.jsonl");
    writeLinkageCache(cachePath, {
      [parentPath]: cacheEntry(parentPath, { rolloutId: CODEX_PARENT_UUID }),
      [stalePath]: staleCacheEntry(stalePath),
    });
    const collector = collectorOver(root, [parentPath], cachePath);

    await collector.prepareSourceBatch?.([parentPath]);

    assert.deepEqual(readCacheKeys(cachePath), [parentPath]);
  });

  test("keeps parsing when the cache path cannot be written", async () => {
    const root = makeTempDir("codex-cache-unwritable-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, childLines());
    // A regular file where the cache directory would have to be: the mkdir
    // (and therefore the write) fails.
    const blocker = path.join(root, "blocker");
    writeFileSync(blocker, "not-a-directory", "utf8");
    const cachePath = path.join(blocker, "linkage-cache.json");
    const collector = collectorOver(root, [parentPath, childPath], cachePath);

    const [parent] = await collector.parse(parentPath);

    assert.equal(parent.subagents?.length, 1);
    assert.equal(parent.subagents?.[0].id, CODEX_CHILD_UUID);
  });

  test("tolerates a listed source that no longer exists on disk", async () => {
    const root = makeTempDir("codex-missing-source-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, childLines());
    const vanished = codexRolloutPath(
      root,
      ABSENT_PARENT_UUID,
      "2026-06-24T10-09-00"
    );
    const collector = collectorOver(root, [parentPath, childPath, vanished]);

    const [parent] = await collector.parse(parentPath);

    assert.equal(parent.subagents?.length, 1);
    assert.equal(parent.subagents?.[0].id, CODEX_CHILD_UUID);
  });
});

describe("Codex collector — graph lifecycle", () => {
  test("builds the rollout graph lazily for isBurstArtifactSource", () => {
    const root = makeTempDir("codex-lazy-burst-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, childLines());
    const collector = collectorOver(root, [parentPath, childPath]);

    // First call on a cold collector — nothing has prepared the graph yet.
    assert.equal(collector.isBurstArtifactSource?.(childPath), true);
    assert.equal(collector.isBurstArtifactSource?.(parentPath), false);
    // The same cold path resolves a watch event to the root that owns it.
    assert.deepEqual(
      collector.sourcePathsForWatchEvent?.(
        path.dirname(childPath),
        path.basename(childPath)
      ),
      [parentPath]
    );
  });

  test("extraMtime reports the newest descendant rollout's mtime", () => {
    const root = makeTempDir("codex-extra-mtime-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, childLines());
    const childMtime = new Date("2026-07-01T00:00:00.000Z");
    utimesSync(childPath, childMtime, childMtime);
    const collector = collectorOver(root, [parentPath, childPath]);

    assert.equal(collector.extraMtime?.(parentPath), childMtime.getTime());
  });

  test("extraMtime falls back to the workflow journal when a root has no descendants", () => {
    const root = makeTempDir("codex-extra-mtime-journal-");
    const parentPath = writeParent(root);
    const journalPath = path.join(
      path.dirname(parentPath),
      "workflow-run-1.jsonl"
    );
    writeFileSync(journalPath, "", "utf8");
    const journalMtime = new Date("2026-07-02T00:00:00.000Z");
    utimesSync(journalPath, journalMtime, journalMtime);
    const collector = collectorOver(root, [parentPath]);

    assert.equal(collector.extraMtime?.(parentPath), journalMtime.getTime());
  });

  test("extraMtime is null when there is neither a descendant nor a journal", () => {
    const root = makeTempDir("codex-extra-mtime-none-");
    const parentPath = writeParent(root);
    const collector = collectorOver(root, [parentPath]);

    assert.equal(collector.extraMtime?.(parentPath), null);
  });

  test("a second cooperative prepare with an unchanged stat key reuses the built graph", async () => {
    const root = makeTempDir("codex-prepare-key-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, childLines());
    utimesSync(childPath, PINNED_MTIME, PINNED_MTIME);
    const collector = collectorOver(root, [parentPath, childPath]);
    await collector.prepareSourceBatch?.([parentPath, childPath]);

    // Repoint the child at a parent that does not exist, keeping the byte length
    // AND the mtime identical — the staleness key (path + mtime + size) is
    // therefore unchanged, so the second prepare must NOT rebuild.
    const original = readFileSync(childPath, "utf8");
    const rewritten = original.replaceAll(
      CODEX_PARENT_UUID,
      ABSENT_PARENT_ALT_UUID
    );
    assert.equal(
      rewritten.length,
      original.length,
      "fixture guard: the rewrite must be byte-length stable"
    );
    writeFileSync(childPath, rewritten, "utf8");
    utimesSync(childPath, PINNED_MTIME, PINNED_MTIME);

    await collector.prepareSourceBatch?.([parentPath, childPath]);
    const [parent] = await collector.parse(parentPath);

    assert.equal(
      parent.subagents?.length,
      1,
      "the cached graph still links the child; a rebuild would have orphaned it"
    );
    // Proof the guard above is meaningful: a cold collector over the SAME files
    // does rebuild, and drops the link.
    const cold = collectorOver(root, [parentPath, childPath]);
    const [coldParent] = await cold.parse(parentPath);
    assert.equal(coldParent.subagents?.length, 0);
  });
});

/** Read the persisted linkage cache's entry keys, in file order. */
function readCacheKeys(cachePath: string): string[] {
  const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
    entries: Record<string, unknown>;
  };
  return Object.keys(parsed.entries).sort();
}

/**
 * Persisted-cache entries the validator must reject. Each returns an entry for
 * the given source path that is malformed in exactly one dimension. `overrides`
 * are layered over a well-formed linkage; `entry` patches the outer stat fields.
 */
function rejectedCacheEntryCases(): [string, (path: string) => unknown][] {
  const bad = (
    overrides: Record<string, unknown>,
    entry: Record<string, unknown> = {}
  ) => {
    return (sourcePath: string) => ({
      ...cacheEntry(sourcePath, { rolloutId: CODEX_CHILD_UUID, ...overrides }),
      ...entry,
    });
  };
  return [
    ["is not an object", () => "definitely-not-an-entry"],
    ["has a non-numeric mtimeMs", bad({}, { mtimeMs: "recently" })],
    ["has a non-numeric size", bad({}, { size: null })],
    ["carries an empty rolloutId", bad({ rolloutId: "" })],
    ["carries a non-string rolloutId", bad({ rolloutId: 42 })],
    ["carries a non-string parentThreadId", bad({ parentThreadId: 7 })],
    [
      "carries a non-numeric depth",
      bad({ parentThreadId: CODEX_PARENT_UUID, depth: "one" }),
    ],
  ];
}

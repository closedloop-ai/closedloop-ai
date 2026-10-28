/**
 * @file collector-manager-pass-settle.test.ts
 * @description ISS-8346 — the persisted-store teardown of one import pass,
 * extracted from `collector-manager.ts` and pinned here.
 *
 * The gating is what matters, and the two halves fail in opposite directions.
 * PRUNING a population the pass did not fully enumerate drops entries for
 * sources it never looked at, so the next launch re-parses them. FLUSHING is
 * unconditional for the mirror reason: a pass that ended early still wrote
 * entries, and dropping them is what makes the next launch redo its work.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { CatchupCache } from "../src/main/collectors/engine/catchup-cache.js";
import { settleImportPassStores } from "../src/main/collectors/engine/collector-manager-pass-settle.js";
import type { ParseQuarantine } from "../src/main/collectors/engine/parse-quarantine.js";
import type { HarnessCollector } from "../src/main/collectors/types.js";

const SOURCES = ["/tmp/a.jsonl", "/tmp/b.jsonl"];

type Calls = { pruned: string[][]; flushes: number };

function fakeCache(calls: Calls): CatchupCache {
  return {
    pruneTo: (paths: string[]) => calls.pruned.push(paths),
    flush: () => {
      calls.flushes += 1;
    },
  } as unknown as CatchupCache;
}

function fakeQuarantine(calls: Calls): ParseQuarantine {
  return {
    pruneTo: (paths: string[]) => calls.pruned.push(paths),
    flush: () => {
      calls.flushes += 1;
    },
  } as unknown as ParseQuarantine;
}

function collector(batch: boolean): HarnessCollector {
  return { key: "codex", batch } as unknown as HarnessCollector;
}

function settle(
  overrides: { batch?: boolean; pruneCache?: boolean; isActive?: boolean } = {}
): { cache: Calls; quarantine: Calls } {
  const cache: Calls = { flushes: 0, pruned: [] };
  const quarantine: Calls = { flushes: 0, pruned: [] };
  settleImportPassStores({
    cache: fakeCache(cache),
    collector: collector(overrides.batch ?? false),
    isActive: overrides.isActive ?? true,
    pruneCache: overrides.pruneCache ?? true,
    quarantine: fakeQuarantine(quarantine),
    sources: SOURCES,
  });
  return { cache, quarantine };
}

describe("import-pass store teardown (ISS-8346)", () => {
  test("a live pass over the whole population prunes and flushes both stores", () => {
    const { cache, quarantine } = settle();

    assert.deepEqual(cache.pruned, [SOURCES]);
    assert.deepEqual(quarantine.pruned, [SOURCES]);
    assert.equal(cache.flushes, 1);
    assert.equal(quarantine.flushes, 1);
  });

  test("a partial enumeration flushes but never prunes", () => {
    const { cache, quarantine } = settle({ pruneCache: false });

    assert.deepEqual(cache.pruned, []);
    assert.deepEqual(quarantine.pruned, []);
    assert.equal(cache.flushes, 1);
    assert.equal(quarantine.flushes, 1);
  });

  test("a superseded generation flushes but never prunes", () => {
    // The pass was stopped or replaced mid-flight, so its source list is not
    // the live population — but what it already wrote is still worth keeping.
    const { cache, quarantine } = settle({ isActive: false });

    assert.deepEqual(cache.pruned, []);
    assert.deepEqual(quarantine.pruned, []);
    assert.equal(cache.flushes, 1);
    assert.equal(quarantine.flushes, 1);
  });

  test("a batch collector's catchup cache is left alone, quarantine is not", () => {
    // A batch collector runs with no catchup cache at all; the quarantine store
    // exists for every collector, because a batch source IS its whole DB file.
    const { cache, quarantine } = settle({ batch: true });

    assert.deepEqual(cache.pruned, []);
    assert.equal(cache.flushes, 0);
    assert.deepEqual(quarantine.pruned, [SOURCES]);
    assert.equal(quarantine.flushes, 1);
  });

  test("an absent store is not a crash", () => {
    assert.doesNotThrow(() =>
      settleImportPassStores({
        cache: undefined,
        collector: collector(false),
        isActive: true,
        pruneCache: true,
        quarantine: undefined,
        sources: SOURCES,
      })
    );
  });
});

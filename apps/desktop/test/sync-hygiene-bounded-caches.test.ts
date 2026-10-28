/**
 * @file sync-hygiene-bounded-caches.test.ts
 * @description ISS-8611 — the long-lived session-attribution resolver caches
 * (keyed by session `cwd`) accumulate keys from external input and must stop
 * growing.
 *
 * `main/sync/AGENTS.md` invariant 10 asks for two properties, and each is
 * asserted separately here because one cannot cover the other:
 *
 *  - the map STOPS at its cap, and
 *  - eviction degrades to "re-discovered later", never to "lost" — for the
 *    attribution cache that is a re-resolve on the next miss.
 *
 * Every cap is written here as a LITERAL, independently of the production
 * constant, so a constant that silently changes fails this file rather than
 * carrying its own expectation with it.
 *
 * ISS-9678 moved `BoundedMap` itself to `@repo/lib/bounded-map`, and its own
 * unit cases — eviction order, rewrite refresh, and the cap-validation table —
 * went with it to `packages/lib/bounded-map.test.ts`. What stays here is the
 * desktop wiring: that this owner is capped, and that its eviction degrades to
 * re-discovered rather than to lost.
 *
 * Counterfactual: widening the cap comparison from `>=` to `>` fails both
 * attribution-cap cases.
 *
 * What NO case here covers, stated so the next reader does not mistake this file
 * for wiring coverage: the two long-lived CONSTRUCTION sites —
 * `AgentSessionSyncService`'s private field and `createSqliteImporter`'s closure
 * cache. Neither has a test seam that does not require driving thousands of real
 * filesystem resolutions, so reverting either to `new Map()` leaves this file
 * green. And `tsc` cannot stand in for that: `BoundedMap` subclasses `Map`
 * precisely so the cache type accepts it, which means the old plain-`Map`
 * literal type-checks just as well. Their wiring rests on review alone.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { BoundedMap } from "@repo/lib/bounded-map";
import { describe, test } from "vitest";
import {
  resolveSessionAttribution,
  type SessionAttributionResolverCache,
} from "../src/main/agent-sync/agent-session-attribution.js";
import {
  createLongLivedSessionAttributionCache,
  SESSION_ATTRIBUTION_CACHE_MAX_ENTRIES,
} from "../src/main/agent-sync/session-attribution-cache.js";

describe("long-lived session attribution cache", () => {
  test("caps every map at 4096 entries", () => {
    // The literal is written here rather than read from the constant: the
    // duplication is what makes a silent retune fail this test.
    assert.equal(SESSION_ATTRIBUTION_CACHE_MAX_ENTRIES, 4096);
    const cache = createLongLivedSessionAttributionCache();
    for (let index = 0; index < 4096 + 50; index += 1) {
      cache.attributionByCwd.set(`/cwd-${index}`, null);
      cache.launchMetadataRootByCwd.set(`/cwd-${index}`, null);
      cache.repoFullNameByPath.set(`/cwd-${index}`, null);
    }
    assert.equal(cache.attributionByCwd.size, 4096);
    assert.equal(cache.launchMetadataRootByCwd.size, 4096);
    assert.equal(cache.repoFullNameByPath.size, 4096);
  });

  test("the production resolver's memo writes go through the cap", () => {
    // A cap of 2 rather than the production 4096 so the case drives the real
    // filesystem resolver a handful of times instead of thousands.
    const cache: SessionAttributionResolverCache = {
      attributionByCwd: new BoundedMap(2),
      launchMetadataRootByCwd: new BoundedMap(2),
      repoFullNameByPath: new BoundedMap(2),
    };
    const root = path.join(os.tmpdir(), "iss-8611-absent-worktrees");
    const cwds = [0, 1, 2, 3, 4].map((index) =>
      path.join(root, `cwd-${index}`)
    );
    for (const cwd of cwds) {
      resolveSessionAttribution(cwd, cache);
    }
    assert.equal(cache.attributionByCwd.size, 2);
    assert.deepEqual([...cache.attributionByCwd.keys()], cwds.slice(-2));

    // Eviction degraded to "re-resolved later", not to "lost": the evicted cwd
    // still answers, and answers the same thing it did the first time.
    const reResolved = resolveSessionAttribution(cwds[0], cache);
    assert.ok(reResolved, "an evicted cwd must still resolve");
    assert.deepEqual(resolveSessionAttribution(cwds[0], cache), reResolved);
  });
});

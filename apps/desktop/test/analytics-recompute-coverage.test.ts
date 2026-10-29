/**
 * @file analytics-recompute-coverage.test.ts
 * @description ISS-8730 coverage for analytics-recompute.ts:
 * `recomputeAnalyticsRollupsFor`, the re-derivation of `session_analytics` (+
 * FEA-2273 activity-metrics) rollups for an explicit set of session ids.
 *
 * `recomputeAnalyticsRollupsFor` and the private `refreshMetricsAfterRecompute`
 * it calls each drive exactly ONE outcome through `DesktopPrisma.write` per
 * concern (the PRIMARY analytics transaction, then a SEPARATE best-effort
 * metrics transaction) and never inspect what the callback returns — only
 * whether the returned promise resolves or rejects. That makes `write` the
 * single seam this suite needs: a scripted recording mock controls each
 * write's outcome in call order, without needing to fake the real SQL those
 * transactions run (`upsertSessionAnalyticsRollupBatch` /
 * `upsertActivityMetricsRollupBatch`), which would need a real SQLite store to
 * execute meaningfully. `chunkSessionIdsByMetadataBudget`'s own metadata-size
 * lookup is stubbed to report every id as 0 bytes, so chunking is driven
 * purely by the documented 25-id count cap (`SESSION_ANALYTICS_BACKFILL_CHUNK`),
 * which this file treats as a known constant rather than re-deriving.
 *
 * Pins CURRENT behavior only; does not change apps/desktop source.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { recomputeAnalyticsRollupsFor } from "../src/main/database/analytics-recompute.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";

type WriteOutcome = "ok" | "fail";

/**
 * A `DesktopPrisma` double whose `write()` calls are scripted by call order —
 * `outcomes[i]` decides whether the i-th `write()` call (across the whole
 * `recomputeAnalyticsRollupsFor` run, not per chunk) resolves or rejects. Any
 * call past the end of `outcomes` resolves. The passed callback is
 * deliberately never invoked: `write()`'s caller only observes settle/reject.
 */
function createScriptedPrisma(
  outcomes: WriteOutcome[],
  failureMessage: (callIndex: number) => string = (i) => `boom-${i}`
): {
  prisma: DesktopPrisma;
  writeCallCount: () => number;
} {
  let callIndex = 0;
  const prisma = {
    client: {
      $queryRawUnsafe: () => Promise.resolve([]),
    },
    write: () => {
      const idx = callIndex;
      callIndex += 1;
      const outcome = outcomes[idx] ?? "ok";
      return outcome === "ok"
        ? Promise.resolve(undefined)
        : Promise.reject(new Error(failureMessage(idx)));
    },
    read: () => {
      throw new Error("unexpected read() call");
    },
    disconnect: () => {
      throw new Error("unexpected disconnect() call");
    },
    readWalProbeHealth: () => {
      throw new Error("unexpected readWalProbeHealth() call");
    },
    readStorageExhaustionHealth: () => {
      throw new Error("unexpected readStorageExhaustionHealth() call");
    },
  } as unknown as DesktopPrisma;
  return { prisma, writeCallCount: () => callIndex };
}

/** A prisma double every method of which throws — proves a code path never
 * touches the database at all. */
function untouchablePrisma(): DesktopPrisma {
  const fail = (name: string) => (): never => {
    throw new Error(`unexpected ${name}() call`);
  };
  return {
    client: { $queryRawUnsafe: fail("client.$queryRawUnsafe") },
    write: fail("write"),
    read: fail("read"),
    disconnect: fail("disconnect"),
    readWalProbeHealth: fail("readWalProbeHealth"),
    readStorageExhaustionHealth: fail("readStorageExhaustionHealth"),
  } as unknown as DesktopPrisma;
}

const NOW_ISO = "2026-01-01T00:00:00.000Z";

const PRIMARY_FAILURE_LOG_RE =
  /recomputeAnalyticsRollups failed for chunk \[0, 3\): boom/;
const METRICS_FAILURE_LOG_RE =
  /recomputeAnalyticsRollups metrics refresh failed for 2 session\(s\): metrics-boom/;
const SECOND_CHUNK_FAILURE_LOG_RE =
  /recomputeAnalyticsRollups failed for chunk \[25, 30\): chunk2-boom/;

describe("recomputeAnalyticsRollupsFor", () => {
  test("returns the zero-result shape and never touches prisma when sessionIds is empty", async () => {
    const prisma = untouchablePrisma();
    const log: string[] = [];
    const result = await recomputeAnalyticsRollupsFor(
      prisma,
      [],
      () => NOW_ISO,
      (m) => log.push(m)
    );
    assert.deepEqual(result, {
      attempted: 0,
      committed: 0,
      failed: 0,
      failedSessionIds: [],
    });
    assert.deepEqual(log, []);
  });

  test("reports committed with zero failures when both the analytics and metrics writes succeed", async () => {
    const { prisma, writeCallCount } = createScriptedPrisma(["ok", "ok"]);
    const log: string[] = [];
    const result = await recomputeAnalyticsRollupsFor(
      prisma,
      ["a", "b", "c"],
      () => NOW_ISO,
      (m) => log.push(m)
    );
    assert.deepEqual(result, {
      attempted: 3,
      committed: 3,
      failed: 0,
      failedSessionIds: [],
    });
    assert.equal(writeCallCount(), 2, "one primary write + one metrics write");
    assert.deepEqual(log, []);
  });

  test("counts a failed primary rollup transaction, skips the metrics write, and logs the chunk range", async () => {
    const { prisma, writeCallCount } = createScriptedPrisma(
      ["fail"],
      () => "boom"
    );
    const log: string[] = [];
    const result = await recomputeAnalyticsRollupsFor(
      prisma,
      ["a", "b", "c"],
      () => NOW_ISO,
      (m) => log.push(m)
    );
    assert.deepEqual(result, {
      attempted: 3,
      committed: 0,
      failed: 3,
      failedSessionIds: ["a", "b", "c"],
    });
    assert.equal(
      writeCallCount(),
      1,
      "the metrics write must never run once the primary write throws"
    );
    assert.equal(log.length, 1);
    assert.match(log[0], PRIMARY_FAILURE_LOG_RE);
  });

  test("counts a metrics-only failure as failed while still reporting the analytics write committed", async () => {
    const { prisma, writeCallCount } = createScriptedPrisma(
      ["ok", "fail"],
      () => "metrics-boom"
    );
    const log: string[] = [];
    const result = await recomputeAnalyticsRollupsFor(
      prisma,
      ["a", "b"],
      () => NOW_ISO,
      (m) => log.push(m)
    );
    assert.deepEqual(result, {
      attempted: 2,
      committed: 2,
      failed: 2,
      failedSessionIds: ["a", "b"],
    });
    // ISS-5071: `committed` and `failed` are independent axes and deliberately
    // overlap on a metrics-only failure — the analytics rows really did commit
    // (so caches must invalidate) even though the pass is not fully repaired
    // (so the data-revision stamp must still be withheld). Per the type's own
    // doc comment, `committed + failed` may exceed `attempted`.
    assert.ok(result.committed + result.failed > result.attempted);
    assert.equal(writeCallCount(), 2);
    assert.equal(log.length, 1);
    assert.match(log[0], METRICS_FAILURE_LOG_RE);
  });

  test("continues past a failed chunk and still repairs the remaining ones", async () => {
    // 30 ids, all reporting 0 metadata bytes, pack purely by the 25-id count
    // cap: chunk1 = ids[0..24] (25), chunk2 = ids[25..29] (5).
    const ids = Array.from({ length: 30 }, (_, i) => `sess-${i}`);
    const { prisma, writeCallCount } = createScriptedPrisma(
      ["ok", "ok", "fail"],
      () => "chunk2-boom"
    );
    const log: string[] = [];
    const result = await recomputeAnalyticsRollupsFor(
      prisma,
      ids,
      () => NOW_ISO,
      (m) => log.push(m)
    );
    assert.equal(result.attempted, 30);
    assert.equal(result.committed, 25, "chunk1 fully repaired");
    assert.equal(result.failed, 5, "only chunk2 is unrepaired");
    assert.deepEqual(result.failedSessionIds, ids.slice(25));
    assert.equal(
      writeCallCount(),
      3,
      "chunk1 primary+metrics, then chunk2 primary; chunk2 metrics never attempted"
    );
    assert.equal(log.length, 1);
    assert.match(log[0], SECOND_CHUNK_FAILURE_LOG_RE);
  });
});

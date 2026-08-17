/**
 * @file data-revision-rollup-stamp-gate.test.ts
 * @description The missing-source analytics-rollup repair and the `data_revision`
 * stamp gate it feeds, extracted from `data-revision-rebuild.test.ts` (ISS-5071)
 * so that grandfathered file stops growing and this one cohesive concern reads on
 * its own.
 *
 * The concern: sessions whose source transcript is gone cannot be re-parsed, so
 * `runDataRevisionRebuild` repairs them by recomputing `session_analytics` from
 * stored metadata and only then lets the FEA-3294 stored-invocation bridge stamp
 * `data_revision`. Everything here pins one of the two INDEPENDENT axes that
 * repair reports:
 *
 * - the stamp gate (FEA-3597) — a thrown repair, a swallowed per-chunk failure,
 *   and an absent bridge must each withhold the stamp so the session stays
 *   retryable rather than being sealed with un-rebuilt derived rows;
 * - the invalidation signal (ISS-5071) — `missingSourceRollupsRecomputed` counts
 *   PRIMARY `session_analytics` transactions that committed, so a metrics-only
 *   failure still tells post-boot maintenance to drop its caches.
 *
 * The rebuild orchestrator's other behaviors (parse paths, deletion, lifecycle,
 * concurrency) stay in `data-revision-rebuild.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DATA_REVISION } from "../src/main/collectors/engine/data-revision.js";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { fakeCollector } from "./normalized-session-test-utils.js";

describe("missing-source analytics repair and the data_revision stamp gate", () => {
  test("missing-source sessions recompute analytics and use the stored bridge", async () => {
    const rebuilt: Array<{ sessionId: string; revision: number }> = [];
    const recomputed: string[][] = [];
    const result = await runDataRevisionRebuild({
      collectors: [fakeCollector("claude", { sources: [] })],
      db: {
        listStaleRevisionSessions: async () => [
          { id: "missing-source", harness: "claude", status: "inactive" },
          { id: "still-running", harness: "claude", status: "running" },
        ],
        rebuildSessionFromParse: () => {
          throw new Error("missing source must not use parser rebuild");
        },
        rebuildComponentInvocationsFromStoredRows: (sessionId, revision) => {
          rebuilt.push({ sessionId, revision });
          return Promise.resolve({
            rebuilt: true,
            activeRace: false,
            contentChanged: true,
          });
        },
        deleteSessionRow: () => Promise.resolve(),
        recomputeAnalyticsRollups: (sessionIds) => {
          recomputed.push(sessionIds);
          // FEA-3597: the bridge now reports real per-chunk outcomes; the
          // rebuild GATES a data_revision stamp on this.
          return Promise.resolve({
            attempted: sessionIds.length,
            committed: sessionIds.length,
            failed: 0,
          });
        },
      },
      parseSource: () => {
        throw new Error("missing source must not be parsed");
      },
      useStoredComponentInvocationRebuild: true,
    });

    assert.deepEqual(rebuilt, [
      { sessionId: "missing-source", revision: DATA_REVISION },
    ]);
    assert.deepEqual(recomputed, [["missing-source"]]);
    assert.equal(result.rebuilt, 1);
    assert.equal(result.skippedActive, 1);
    assert.equal(result.missingSource, 1);
    assert.equal(result.missingSourceRollupsRecomputed, 1);
    assert.deepEqual(result.changedSessionIds, ["missing-source"]);
  });

  test("a failed missing-source analytics repair withholds the stored revision stamp", async () => {
    let storedBridgeCalls = 0;
    const result = await runDataRevisionRebuild({
      collectors: [fakeCollector("claude", { sources: [] })],
      db: {
        listStaleRevisionSessions: async () => [
          { id: "analytics-retry", harness: "claude", status: "inactive" },
        ],
        rebuildSessionFromParse: () => {
          throw new Error("missing source must not use parser rebuild");
        },
        rebuildComponentInvocationsFromStoredRows: () => {
          storedBridgeCalls++;
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
        deleteSessionRow: () => Promise.resolve(),
        recomputeAnalyticsRollups: () =>
          Promise.reject(new Error("analytics write failed")),
      },
      useStoredComponentInvocationRebuild: true,
    });

    assert.equal(storedBridgeCalls, 0);
    assert.equal(result.rebuilt, 0);
    assert.equal(result.missingSource, 1);
    assert.equal(result.missingSourceRollupsRecomputed, 0);
  });

  test("FEA-3597: a SWALLOWED per-chunk failure also withholds the stamp", async () => {
    // The recompute catches per-chunk failures internally and never throws, so
    // "it did not reject" is NOT evidence of repair. Before FEA-3597 the
    // readiness signal could therefore never be false, and the stamp landed on
    // sessions whose derived rows had not been rebuilt. Gate on the reported
    // outcome instead.
    let storedBridgeCalls = 0;
    const result = await runDataRevisionRebuild({
      collectors: [fakeCollector("claude", { sources: [] })],
      db: {
        listStaleRevisionSessions: async () => [
          { id: "chunk-failed", harness: "claude", status: "inactive" },
        ],
        rebuildSessionFromParse: () => {
          throw new Error("missing source must not use parser rebuild");
        },
        rebuildComponentInvocationsFromStoredRows: () => {
          storedBridgeCalls++;
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
        deleteSessionRow: () => Promise.resolve(),
        // Resolves — but reports that the chunk did not rebuild: the PRIMARY
        // analytics transaction itself failed, so nothing committed.
        recomputeAnalyticsRollups: (ids) =>
          Promise.resolve({
            attempted: ids.length,
            committed: 0,
            failed: ids.length,
          }),
      },
      useStoredComponentInvocationRebuild: true,
    });

    assert.equal(
      storedBridgeCalls,
      0,
      "the stamping bridge must NOT run when the repair reported failure"
    );
    assert.equal(result.missingSourceRollupsRecomputed, 0);
  });

  test("ISS-5071: a metrics-only failure still reports the committed analytics recompute (invalidation) while withholding the stamp", async () => {
    // The recompute writes twice per chunk: the PRIMARY session_analytics
    // transaction, then a separate best-effort activity-metrics transaction.
    // When only the SECOND fails, analytics rows on disk HAVE been rewritten —
    // so post-boot maintenance (which gates invalidateHistoricalDetails() and
    // desktop:db:changed on `missingSourceRollupsRecomputed > 0`) must still
    // fire, or every mounted Insights query serves pre-recompute numbers until
    // some unrelated DB event lands. The stamp is the separate question, and it
    // stays withheld so the session is retried on the next boot.
    let storedBridgeCalls = 0;
    const result = await runDataRevisionRebuild({
      collectors: [fakeCollector("claude", { sources: [] })],
      db: {
        listStaleRevisionSessions: async () => [
          { id: "metrics-only-failed", harness: "claude", status: "inactive" },
        ],
        rebuildSessionFromParse: () => {
          throw new Error("missing source must not use parser rebuild");
        },
        rebuildComponentInvocationsFromStoredRows: () => {
          storedBridgeCalls++;
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
        deleteSessionRow: () => Promise.resolve(),
        // The analytics transaction committed; only the metrics refresh failed.
        recomputeAnalyticsRollups: (ids) =>
          Promise.resolve({
            attempted: ids.length,
            committed: ids.length,
            failed: ids.length,
          }),
      },
      useStoredComponentInvocationRebuild: true,
    });

    assert.equal(
      result.missingSourceRollupsRecomputed,
      1,
      "the committed analytics recompute must be reported so the caller invalidates its caches — `attempted - failed` would report 0 here"
    );
    assert.equal(
      storedBridgeCalls,
      0,
      "the stamp is the OTHER axis and stays withheld while the repair is incomplete"
    );
  });

  test("FEA-3597: an ABSENT recompute bridge is failure, not vacuous success", async () => {
    // With a non-empty id list and no bridge, nothing repaired anything — so
    // reporting readiness would stamp un-rebuilt sessions. Only a genuinely
    // EMPTY list is a vacuous success.
    let storedBridgeCalls = 0;
    const result = await runDataRevisionRebuild({
      collectors: [fakeCollector("claude", { sources: [] })],
      db: {
        listStaleRevisionSessions: async () => [
          { id: "no-bridge", harness: "claude", status: "inactive" },
        ],
        rebuildSessionFromParse: () => {
          throw new Error("missing source must not use parser rebuild");
        },
        rebuildComponentInvocationsFromStoredRows: () => {
          storedBridgeCalls++;
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
        deleteSessionRow: () => Promise.resolve(),
        // recomputeAnalyticsRollups deliberately omitted.
      },
      useStoredComponentInvocationRebuild: true,
    });

    assert.equal(
      storedBridgeCalls,
      0,
      "no bridge means no repair, so the stamp must be withheld"
    );
    assert.equal(result.missingSourceRollupsRecomputed, 0);
  });

  test("ISS-6165: a PARTIAL repair stamps the sessions that repaired and withholds only the ones that did not", async () => {
    // The non-convergence bug. The stamp gate was one boolean for the whole
    // pass, so a single failing chunk withheld the stamp from every repairable
    // session. On the operator's machine that cohort was 440 sessions: each
    // pass repaired ~439 of them, retired NONE, and the next pass re-selected
    // the identical cohort and hit the identical failure — a rebuild that could
    // log `complete` forever while the stale population never shrank.
    //
    // Three sessions, one of which the bridge names as unrepaired. The two that
    // repaired must be stamped.
    const stamped: string[] = [];
    const result = await runDataRevisionRebuild({
      collectors: [fakeCollector("claude", { sources: [] })],
      db: {
        listStaleRevisionSessions: async () => [
          { id: "repaired-a", harness: "claude", status: "inactive" },
          { id: "poisoned", harness: "claude", status: "inactive" },
          { id: "repaired-b", harness: "claude", status: "inactive" },
        ],
        rebuildSessionFromParse: () => {
          throw new Error("missing source must not use parser rebuild");
        },
        rebuildComponentInvocationsFromStoredRows: (sessionId) => {
          stamped.push(sessionId);
          return Promise.resolve({
            rebuilt: true,
            activeRace: false,
            contentChanged: false,
          });
        },
        deleteSessionRow: () => Promise.resolve(),
        recomputeAnalyticsRollups: (ids) =>
          Promise.resolve({
            attempted: ids.length,
            committed: ids.length - 1,
            failed: 1,
            failedSessionIds: ["poisoned"],
          }),
      },
      useStoredComponentInvocationRebuild: true,
    });

    assert.deepEqual(
      stamped.sort(),
      ["repaired-a", "repaired-b"],
      "the sessions that fully repaired must be stamped so the next pass stops re-selecting them — withholding the whole cohort is what made the rebuild non-convergent"
    );
    assert.ok(
      !stamped.includes("poisoned"),
      "the session the bridge named as unrepaired must stay stale and retryable"
    );
    assert.equal(result.rebuilt, 2);
    assert.equal(result.missingSource, 3);
  });

  test("ISS-6165: a failure set SHORTER than the reported failure count withholds the whole cohort", async () => {
    // The severe direction. An empty array is truthy, so a gate keyed on mere
    // PRESENCE reads `{failed: 1, failedSessionIds: []}` as "named, and nobody
    // failed" and stamps the entire cohort — including the session the bridge
    // just reported as unrepaired. That seals un-rebuilt derived rows at the
    // current revision and nothing ever re-selects them: the FEA-3597 defect
    // this gate exists to prevent. The result crosses the db-host proxy, so a
    // producer that violates the length-parity invariant is reachable input,
    // and must degrade to the same conservative withholding as an absent set.
    let storedBridgeCalls = 0;
    await runDataRevisionRebuild({
      collectors: [fakeCollector("claude", { sources: [] })],
      db: {
        listStaleRevisionSessions: async () => [
          { id: "short-a", harness: "claude", status: "inactive" },
          { id: "short-b", harness: "claude", status: "inactive" },
        ],
        rebuildSessionFromParse: () => {
          throw new Error("missing source must not use parser rebuild");
        },
        rebuildComponentInvocationsFromStoredRows: () => {
          storedBridgeCalls++;
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
        deleteSessionRow: () => Promise.resolve(),
        // Reports one failure but names none — the invariant is violated.
        recomputeAnalyticsRollups: (ids) =>
          Promise.resolve({
            attempted: ids.length,
            committed: ids.length - 1,
            failed: 1,
            failedSessionIds: [],
          }),
      },
      useStoredComponentInvocationRebuild: true,
    });

    assert.equal(
      storedBridgeCalls,
      0,
      "a failure set that does not account for every reported failure must withhold the whole cohort, never stamp it"
    );
  });

  test("ISS-6165: a failure set the bridge does NOT name still withholds the whole cohort", async () => {
    // Compatibility arm. The result crosses the db-host utilityProcess proxy,
    // so an older host build reports only the counts. An unknown failure set
    // must never be read as an empty one — that would stamp sessions whose
    // outcome nothing established, which is the FEA-3597 defect in reverse.
    let storedBridgeCalls = 0;
    await runDataRevisionRebuild({
      collectors: [fakeCollector("claude", { sources: [] })],
      db: {
        listStaleRevisionSessions: async () => [
          { id: "unknown-a", harness: "claude", status: "inactive" },
          { id: "unknown-b", harness: "claude", status: "inactive" },
        ],
        rebuildSessionFromParse: () => {
          throw new Error("missing source must not use parser rebuild");
        },
        rebuildComponentInvocationsFromStoredRows: () => {
          storedBridgeCalls++;
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
        deleteSessionRow: () => Promise.resolve(),
        // Pre-ISS-6165 shape: counts only, no `failedSessionIds`.
        recomputeAnalyticsRollups: (ids) =>
          Promise.resolve({
            attempted: ids.length,
            committed: ids.length - 1,
            failed: 1,
          }),
      },
      useStoredComponentInvocationRebuild: true,
    });

    assert.equal(
      storedBridgeCalls,
      0,
      "with no named failure set the gate must stay conservative and withhold every session"
    );
  });

  test("ISS-6165 (@wongk): a failure set naming a FOREIGN session withholds the whole cohort", async () => {
    // A count match does not prove these ARE the failed sessions. The bridge
    // reports one failure and names one id — but it is not in the cohort we
    // asked about, so the filter withholds from nobody and stamps BOTH
    // sessions, including the one that genuinely failed. Nothing re-selects a
    // stamped session, so that unrepaired rollup is sealed for good: the
    // FEA-3597 defect this gate exists to prevent, reached through a gate that
    // only checked length.
    const stamped: string[] = [];
    await runDataRevisionRebuild({
      collectors: [fakeCollector("claude", { sources: [] })],
      db: {
        listStaleRevisionSessions: async () => [
          { id: "foreign-a", harness: "claude", status: "inactive" },
          { id: "foreign-b", harness: "claude", status: "inactive" },
        ],
        rebuildSessionFromParse: () => {
          throw new Error("missing source must not use parser rebuild");
        },
        rebuildComponentInvocationsFromStoredRows: (sessionId) => {
          stamped.push(sessionId);
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
        deleteSessionRow: () => Promise.resolve(),
        recomputeAnalyticsRollups: (ids) =>
          Promise.resolve({
            attempted: ids.length,
            committed: ids.length - 1,
            failed: 1,
            // Right length, wrong session — never a member of this cohort.
            failedSessionIds: ["a-session-we-never-asked-about"],
          }),
      },
      useStoredComponentInvocationRebuild: true,
    });

    assert.deepEqual(
      stamped,
      [],
      "a named set carrying an id outside the cohort cannot identify the failures, so it must withhold every session rather than stamp the real failure as repaired"
    );
  });

  test("ISS-6165 (@wongk): a failure set padded with a DUPLICATE withholds the whole cohort", async () => {
    // The other shape a length check waves through. Two failures, two ids —
    // but the same id twice, so it collapses to a single withheld session and
    // the SECOND genuine failure is stamped as repaired.
    const stamped: string[] = [];
    await runDataRevisionRebuild({
      collectors: [fakeCollector("claude", { sources: [] })],
      db: {
        listStaleRevisionSessions: async () => [
          { id: "dupe-a", harness: "claude", status: "inactive" },
          { id: "dupe-b", harness: "claude", status: "inactive" },
          { id: "dupe-c", harness: "claude", status: "inactive" },
        ],
        rebuildSessionFromParse: () => {
          throw new Error("missing source must not use parser rebuild");
        },
        rebuildComponentInvocationsFromStoredRows: (sessionId) => {
          stamped.push(sessionId);
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
        deleteSessionRow: () => Promise.resolve(),
        recomputeAnalyticsRollups: (ids) =>
          Promise.resolve({
            attempted: ids.length,
            committed: ids.length - 2,
            failed: 2,
            // Length 2 matches `failed`, but it accounts for ONE session.
            failedSessionIds: ["dupe-a", "dupe-a"],
          }),
      },
      useStoredComponentInvocationRebuild: true,
    });

    assert.deepEqual(
      stamped,
      [],
      "a named set whose unique membership is smaller than the failure count leaves a genuine failure unaccounted for, so the gate must withhold the whole cohort"
    );
  });

  test("ISS-6165: a consistent named subset is still honoured after the membership checks", async () => {
    // The inverse of the two above, so tightening the gate cannot silently
    // turn it into blanket cohort-wide withholding — which would restore the
    // ISS-6165 non-convergence the named-subset path exists to fix.
    const stamped: string[] = [];
    await runDataRevisionRebuild({
      collectors: [fakeCollector("claude", { sources: [] })],
      db: {
        listStaleRevisionSessions: async () => [
          { id: "ok-a", harness: "claude", status: "inactive" },
          { id: "ok-b", harness: "claude", status: "inactive" },
          { id: "really-failed", harness: "claude", status: "inactive" },
        ],
        rebuildSessionFromParse: () => {
          throw new Error("missing source must not use parser rebuild");
        },
        rebuildComponentInvocationsFromStoredRows: (sessionId) => {
          stamped.push(sessionId);
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
        deleteSessionRow: () => Promise.resolve(),
        recomputeAnalyticsRollups: (ids) =>
          Promise.resolve({
            attempted: ids.length,
            committed: ids.length - 1,
            failed: 1,
            failedSessionIds: ["really-failed"],
          }),
      },
      useStoredComponentInvocationRebuild: true,
    });

    assert.deepEqual(
      stamped.sort(),
      ["ok-a", "ok-b"],
      "a unique, in-cohort set matching the failure count must still retire the sessions that repaired"
    );
  });
});

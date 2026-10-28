/**
 * @file data-revision-rebuild-summary-merge.test.ts
 * @description How a re-driven rebuild's attempts fold into one summary.
 *
 * `mergeDataRevisionRebuildSummaries` had no test at all. It hand-lists which
 * fields accumulate and which are taken from the last attempt, so a field added
 * to the summary and forgotten here is silently dropped from every merged
 * result — the failure mode that motivated writing this (ISS-8601 added
 * `wedgedActiveAdmitted`).
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createEmptyDataRevisionRebuildSummary } from "../src/main/collectors/engine/data-revision-rebuild-summary.js";
import { mergeDataRevisionRebuildSummaries } from "../src/main/collectors/engine/data-revision-rebuild-summary-merge.js";

function attempt(
  overrides: Partial<ReturnType<typeof createEmptyDataRevisionRebuildSummary>>
) {
  return { ...createEmptyDataRevisionRebuildSummary(), ...overrides };
}

describe("mergeDataRevisionRebuildSummaries", () => {
  test("committed work ACCUMULATES across attempts", () => {
    const merged = mergeDataRevisionRebuildSummaries([
      attempt({ rebuilt: 2, deleted: 1, changedSessionIds: ["a"] }),
      attempt({ rebuilt: 3, deleted: 1, changedSessionIds: ["b"] }),
    ]);
    assert.equal(merged.rebuilt, 5);
    assert.equal(merged.deleted, 2);
    assert.deepEqual(merged.changedSessionIds.sort(), ["a", "b"]);
  });

  test("observation counters take the LAST attempt's view, not a sum", () => {
    // They describe a population the next attempt re-observes, so summing would
    // double-count the rows still stale after attempt one.
    const merged = mergeDataRevisionRebuildSummaries([
      attempt({ staleTotal: 10, skippedActive: 4, raceSkipped: 2 }),
      attempt({ staleTotal: 6, skippedActive: 1, raceSkipped: 0 }),
    ]);
    assert.equal(merged.staleTotal, 6);
    assert.equal(merged.skippedActive, 1);
    assert.equal(merged.raceSkipped, 0);
  });

  test("ISS-8601: wedgedActiveAdmitted survives the fold as the last attempt's view", () => {
    // The regression this file exists for: a field the merge does not know is not
    // merely mis-merged, it is dropped to the zero value entirely, and the counter
    // that reports the backstop firing would read 0 on every re-driven pass.
    const merged = mergeDataRevisionRebuildSummaries([
      attempt({ wedgedActiveAdmitted: 5 }),
      attempt({ wedgedActiveAdmitted: 2 }),
    ]);
    assert.equal(merged.wedgedActiveAdmitted, 2);
  });

  test("an empty attempt list yields the zero summary", () => {
    const merged = mergeDataRevisionRebuildSummaries([]);
    assert.deepEqual(merged, createEmptyDataRevisionRebuildSummary());
  });

  test("storageReset is sticky once any attempt saw it", () => {
    const merged = mergeDataRevisionRebuildSummaries([
      attempt({ storageReset: true }),
      attempt({ storageReset: false }),
    ]);
    assert.equal(merged.storageReset, true);
  });
});

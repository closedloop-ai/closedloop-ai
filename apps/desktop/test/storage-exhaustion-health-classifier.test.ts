/**
 * @file storage-exhaustion-health-classifier.test.ts
 * @description ISS-7581. `classifyStorageExhaustionHealth` — the pure fold from
 * a storage-exhaustion tally to a store-integrity issue — driven at its own
 * seam.
 *
 * Its early return is `if (health.failures <= 0 && !health.active) return;`, and
 * before this the function had no test at all: `storage-exhaustion-monitored`
 * builds tallies and asserts on the wired probe, so the classifier was only ever
 * reached through a fixture that could not construct the one shape its own doc
 * comment names as the interesting one.
 *
 * That shape is `{failures: 0, active: true}` — a latch still held after a READ
 * consumed the failure window. The count and the state are different facts, and
 * a fold that gated on the count alone would report the store healthy while it
 * was still refusing writes, emitting `store.integrity.recovered` off an idle
 * interval rather than off an actual recovery. That is the case pinned here.
 *
 * Kept out of `storage-exhaustion-monitored.test.ts` because it needs none of
 * that suite's `PRAGMA max_page_count` store fixture — this is a pure function
 * over a plain record, and it belongs at a seam that says so.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyStorageExhaustionHealth } from "../src/main/database/storage-exhaustion-integrity.js";
import type { StoreIntegrityIssue } from "../src/main/telemetry/telemetry-protocol.js";
import { StorageExhaustionReason } from "../src/shared/storage-exhaustion.js";

test("a still-active latch remains unhealthy after its failure count is consumed", () => {
  const issues: StoreIntegrityIssue[] = [];

  classifyStorageExhaustionHealth(
    {
      failures: 0,
      lastReason: StorageExhaustionReason.Enospc,
      active: true,
    },
    issues
  );

  assert.deepEqual(issues, [
    {
      check: "storage_exhaustion",
      category: "storage_exhausted",
      object: StorageExhaustionReason.Enospc,
      objectType: "unknown",
    },
  ]);
});

test("a settled tally with no failures reports nothing", () => {
  const issues: StoreIntegrityIssue[] = [];

  classifyStorageExhaustionHealth(
    { failures: 0, lastReason: null, active: false },
    issues
  );

  assert.deepEqual(
    issues,
    [],
    "the early return is what keeps a healthy store off the integrity event"
  );
});

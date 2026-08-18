/**
 * @file activity-taxonomy-shared-key-contract.test.ts
 * @description ISS-5944 — pin the desktop PRODUCER's phase keys to the shared
 * consumer constants in `@repo/lib`.
 *
 * `ACTIVITY_PHASE` (`src/main/collectors/parsing/activity-taxonomy.ts`) is the
 * SSOT for what `classifyActivitySegments` writes into the `phase` column, and
 * those rows sync to BOTH shells verbatim. The read side does not import the
 * taxonomy — it cannot, without inverting the dependency direction — so it
 * re-declares the two non-active buckets as `IDLE_PHASE_KEY` / `OTHER_PHASE_KEY`
 * and every read-side matcher on `phase` resolves through those two constants:
 * `session-timeline-projection.ts` drops idle rows before pricing,
 * `activity-segments-projection.ts` classifies the strip's idle/unavailable
 * kinds, `activity-rollup.ts` excludes them from the "% active" denominator, and
 * `activity-segment-aggregation.ts` labels them.
 *
 * Both sides of that string equality are now spelled through a named constant,
 * which is what makes the drift SILENT: the consumers' own suites build their
 * fixtures from the consumer constant, so renaming `ACTIVITY_PHASE.Idle` alone
 * leaves every one of them green while real idle rows stop being recognised and
 * start receiving spend. This file is the one place the two spellings are
 * compared, so that rename fails here instead of in a cost breakdown.
 *
 * `unattributed` is asserted to be NOT a producer key on purpose: it is the read
 * side's residual for wall-time the classifier never tiled. A taxonomy that
 * started emitting it would make tiled spend indistinguishable from unobserved
 * spend in the exact bucket whose whole job is to mean "we never saw this".
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { UNATTRIBUTED_KEY } from "@repo/lib/branches/activity-rollup";
import {
  IDLE_PHASE_KEY,
  OTHER_PHASE_KEY,
} from "@repo/lib/sessions/activity-segment-aggregation";
import { ACTIVITY_PHASE } from "../src/main/collectors/parsing/activity-taxonomy.js";

const DIVERGENCE_REMEDY = [
  "The desktop classifier's ACTIVITY_PHASE (src/main/collectors/parsing/activity-taxonomy.ts)",
  "and the read-side key constants in @repo/lib are two spellings of ONE wire",
  "contract and must be changed together. The classifier persists this string into",
  "session_activity_segments.phase; the shells match on the @repo/lib constant.",
  "A divergence makes idle rows unrecognisable to the read side — they stop being",
  "excluded and start receiving spend, with nothing else red.",
].join("\n");

describe("the desktop phase taxonomy is the read side's phase taxonomy", () => {
  test("emits idle rows under the key the read side excludes", () => {
    assert.equal(ACTIVITY_PHASE.Idle, IDLE_PHASE_KEY, DIVERGENCE_REMEDY);
  });

  test("emits unclassified-but-active rows under the key the read side labels", () => {
    assert.equal(ACTIVITY_PHASE.Other, OTHER_PHASE_KEY, DIVERGENCE_REMEDY);
  });

  test("never emits the read side's untiled residual as a classified phase", () => {
    assert.ok(
      !Object.values(ACTIVITY_PHASE).includes(
        UNATTRIBUTED_KEY as (typeof ACTIVITY_PHASE)[keyof typeof ACTIVITY_PHASE]
      ),
      `${UNATTRIBUTED_KEY} is the read side's residual for wall-time the classifier never tiled, so the classifier must never name a phase with it.\n${DIVERGENCE_REMEDY}`
    );
  });
});

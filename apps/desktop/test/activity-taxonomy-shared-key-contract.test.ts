/**
 * @file activity-taxonomy-shared-key-contract.test.ts
 * @description ISS-5944: the classifier must never name a phase with the read
 * side's untiled residual. `ACTIVITY_PHASE` (`@repo/api/src/types/activity-phase`)
 * is what `classifyActivitySegments` writes into the `phase` column, and those
 * rows sync to both shells verbatim. The read side's idle and other keys are
 * that same constant (ISS-12552); its `unattributed` residual is a separate
 * constant meaning "wall-time the classifier never tiled". A taxonomy that
 * started emitting it would make tiled spend indistinguishable from unobserved
 * spend in the exact bucket whose job is to mean "we never saw this".
 */
import assert from "node:assert/strict";
import { ACTIVITY_PHASE } from "@repo/api/src/types/activity-phase";
import { UNATTRIBUTED_KEY } from "@repo/lib/branches/activity-rollup";
import { describe, test } from "vitest";

describe("the desktop phase taxonomy is the read side's phase taxonomy", () => {
  test("never emits the read side's untiled residual as a classified phase", () => {
    assert.ok(
      !Object.values(ACTIVITY_PHASE).includes(
        UNATTRIBUTED_KEY as (typeof ACTIVITY_PHASE)[keyof typeof ACTIVITY_PHASE]
      ),
      `${UNATTRIBUTED_KEY} is the read side's residual for wall-time the classifier never tiled, so the classifier must never name a phase with it.`
    );
  });
});

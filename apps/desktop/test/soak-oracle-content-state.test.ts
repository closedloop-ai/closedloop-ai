/**
 * @file soak-oracle-content-state.test.ts
 * @description Invariants of the mock cloud's RETAINED state
 * (`soak-cloud-content.ts`), driven through `recordSessionContent` directly
 * rather than over HTTP.
 *
 * Split from `soak-oracle-content-assertions.test.ts` (which drives the real
 * `POST /desktop/agent-sessions/sync` and read-back routes) because these cases
 * assert something the wire cannot show. Two of them exist precisely BECAUSE a
 * response-level assertion is vacuous here: a violation storm is capped in the
 * serialized read-back either way, and an accumulator that never assembles is
 * only visible as an entry that stays in the retained map. Asserting on
 * `ContentState` is what makes the bound real rather than claimed.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ContentViolationKind,
  freshContentState,
  READBACK_MAX_VIOLATIONS,
  recordSessionContent,
} from "./soak/soak-cloud-content";
import { sessionFixture } from "./soak/soak-oracle-test-support";

describe("ISS-6099: the retained content state is bounded and cannot silence its own checks", () => {
  test("COUNTERFACTUAL — a chunk.total that is not a usable part count is rejected and leaks no accumulator", () => {
    // Driven against `ContentState` directly: the leak IS the observable
    // symptom, and "an accumulator that never assembles" is only visible in the
    // retained map, not in the read-back response.
    const state = freshContentState();
    for (const total of [Number.NaN, 0, -2, 2.5, Number.POSITIVE_INFINITY]) {
      recordSessionContent(
        state,
        sessionFixture({ externalSessionId: `bad-total-${String(total)}` }),
        { index: 0, total }
      );
    }

    assert.equal(
      state.accumulators.size,
      0,
      "a sequence that can never assemble must not be tracked at all"
    );
    assert.equal(state.violationCount, 5);
    assert.ok(
      state.violations.every(
        (entry) => entry.kind === ContentViolationKind.ChunkTotalInvalid
      ),
      JSON.stringify(state.violations)
    );
    // The bad total must not be remembered as this revision's declared total,
    // or every later valid chunk would report a spurious conflict.
    assert.equal(state.declaredTotals.size, 0);
  });

  test("a valid chunk.total is still tracked and still assembles", () => {
    // Other direction: tightening the guard must not stop real sequences.
    const state = freshContentState();
    recordSessionContent(state, sessionFixture(), { index: 0, total: 2 });
    assert.equal(state.accumulators.size, 1);
    assert.equal(state.violationCount, 0);

    recordSessionContent(state, sessionFixture({ events: [{ id: "e9" }] }), {
      index: 1,
      total: 2,
    });
    assert.equal(state.accumulators.size, 0, "the sequence assembled");
    assert.equal(state.delivered.size, 1);
  });

  test("COUNTERFACTUAL — a NaN dataRevision cannot silence the redelivery digest check", () => {
    // `commitDelivery` gates divergence on `existing.dataRevision === entry.dataRevision`,
    // and `NaN === NaN` is false — so a NaN revision made that check unable to
    // fire at all. Same class as the chunk.total and page-read total guards.
    const state = freshContentState();
    recordSessionContent(
      state,
      sessionFixture({ dataRevision: Number.NaN, events: [{ id: "e1" }] }),
      null
    );
    recordSessionContent(
      state,
      sessionFixture({ dataRevision: Number.NaN, events: [{ id: "MUTATED" }] }),
      null
    );

    assert.ok(
      state.violations.some(
        (entry) => entry.kind === ContentViolationKind.DataRevisionInvalid
      ),
      JSON.stringify(state.violations)
    );
    assert.ok(
      state.violations.some(
        (entry) => entry.kind === ContentViolationKind.DigestDivergence
      ),
      `the divergence check must still fire once the revision folds to null, got ${JSON.stringify(state.violations)}`
    );
  });

  test("an ABSENT dataRevision is legitimate and still compares equal to itself", () => {
    // `.nullish()` upstream, so absence is contract-legal — and folding it to
    // `null` keeps the divergence check working, unlike NaN.
    const state = freshContentState();
    const noRevision = sessionFixture({ events: [{ id: "e1" }] });
    // biome-ignore lint/performance/noDelete: the point is a genuinely absent key.
    delete noRevision.dataRevision;
    recordSessionContent(state, noRevision, null);
    const changed = sessionFixture({ events: [{ id: "MUTATED" }] });
    // biome-ignore lint/performance/noDelete: the point is a genuinely absent key.
    delete changed.dataRevision;
    recordSessionContent(state, changed, null);

    assert.deepEqual(
      state.violations.filter(
        (entry) => entry.kind === ContentViolationKind.DataRevisionInvalid
      ),
      [],
      "an absent revision is not an invalid one"
    );
    assert.ok(
      state.violations.some(
        (entry) => entry.kind === ContentViolationKind.DigestDivergence
      ),
      JSON.stringify(state.violations)
    );
  });

  /**
   * The RETAINED state, not the serialized response.
   *
   * `buildReadBackResponse` used to be the only place the cap applied, so a
   * response-level assertion passes whether or not the mock is actually
   * bounded — the exact vacuity this PR exists to remove. Asserting on
   * `ContentState` is what proves the storm was never resident in memory.
   */
  test("COUNTERFACTUAL — retained violation RECORDS stop at the cap, so a storm cannot grow unbounded in memory", () => {
    const state = freshContentState();
    const storm = READBACK_MAX_VIOLATIONS + 60;
    for (let index = 0; index < storm; index++) {
      const broken = sessionFixture({ externalSessionId: `storm-${index}` });
      // biome-ignore lint/performance/noDelete: the point is a genuinely absent key.
      delete broken.startedAt;
      recordSessionContent(state, broken, null);
    }

    assert.equal(
      state.violations.length,
      READBACK_MAX_VIOLATIONS,
      "retained records must stop at the cap"
    );
    assert.equal(state.violationCount, storm, "the exact total is still known");
  });

  test("a violation count BELOW the cap is retained in full", () => {
    const state = freshContentState();
    for (let index = 0; index < 3; index++) {
      const broken = sessionFixture({ externalSessionId: `few-${index}` });
      // biome-ignore lint/performance/noDelete: the point is a genuinely absent key.
      delete broken.startedAt;
      recordSessionContent(state, broken, null);
    }

    assert.equal(state.violations.length, 3);
    assert.equal(state.violationCount, 3);
  });
});

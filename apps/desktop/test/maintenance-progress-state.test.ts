/**
 * @file maintenance-progress-state.test.ts
 * @description ISS-6241 (shafty023 review) — the PRODUCER's honesty guard for
 * the post-boot maintenance counts.
 *
 * The defect these cover: `setPhaseProgress` used to clamp with
 * `Math.max(0, Math.min(processed, total))`, so a producer reporting an
 * impossible `101/100` was published as a believable `100/100` — manufacturing
 * the exact false completion the Compute step exists to avoid, and doing it
 * silently. An uncountable report is now REJECTED to the indeterminate state
 * (phase kept, counts absent) and the invariant breach is logged on the
 * gateway's structured, monitored path rather than swallowed.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createMaintenanceProgressState,
  type MaintenanceProgressState,
} from "../src/main/dashboard/maintenance-progress-state.js";
import { MaintenancePhase } from "../src/shared/maintenance-progress-contract.js";

const GENERATION = 1;
/** The invariant log must name what it rejected, and which phase it belonged to. */
const UNCOUNTABLE_LOG = /uncountable/;
const REBUILD_PHASE_LOG = new RegExp(MaintenancePhase.Rebuild);

/** A state whose generation is always live, with its invariant log captured. */
function makeState(): {
  state: MaintenanceProgressState;
  violations: string[];
} {
  const violations: string[] = [];
  const state = createMaintenanceProgressState(() => true, {
    logInvariantViolation: (message) => violations.push(message),
  });
  return { state, violations };
}

/** Put the rebuild phase on air, which is the precondition for any count. */
function liveRebuild(): {
  state: MaintenanceProgressState;
  violations: string[];
} {
  const made = makeState();
  made.state.setPhase(GENERATION, MaintenancePhase.Rebuild);
  return made;
}

describe("createMaintenanceProgressState — uncountable reports (ISS-6241)", () => {
  test("publishes a real population unchanged", () => {
    const { state, violations } = liveRebuild();

    state.setPhaseProgress(GENERATION, MaintenancePhase.Rebuild, {
      processed: 412,
      total: 1299,
    });

    assert.deepEqual(state.read(), {
      active: true,
      phase: MaintenancePhase.Rebuild,
      processed: 412,
      total: 1299,
    });
    assert.deepEqual(
      violations,
      [],
      "a valid report is not an invariant break"
    );
  });

  // Each of these was previously either clamped into a believable value or
  // dropped without a trace. All must now land in the indeterminate state.
  const uncountable: [string, { processed: number; total: number }][] = [
    [
      "a numerator that outruns its denominator",
      { processed: 101, total: 100 },
    ],
    ["a fractional numerator", { processed: 1.5, total: 10 }],
    ["a fractional denominator", { processed: 1, total: 10.5 }],
    ["a negative numerator", { processed: -1, total: 10 }],
    ["a zero population", { processed: 0, total: 0 }],
    ["a negative population", { processed: 0, total: -5 }],
    ["a NaN numerator", { processed: Number.NaN, total: 10 }],
    [
      "a non-finite denominator",
      { processed: 1, total: Number.POSITIVE_INFINITY },
    ],
    [
      "a denominator past exact integer precision",
      { processed: 1, total: Number.MAX_SAFE_INTEGER + 2 },
    ],
  ];

  for (const [label, counts] of uncountable) {
    test(`rejects ${label} to the indeterminate state`, () => {
      const { state, violations } = liveRebuild();

      state.setPhaseProgress(GENERATION, MaintenancePhase.Rebuild, counts);

      const published = state.read();
      assert.deepEqual(
        published,
        { active: true, phase: MaintenancePhase.Rebuild },
        "the phase stays live; the counts must not be published at all"
      );
      assert.equal(
        "processed" in published,
        false,
        "no coerced numerator may survive"
      );
      assert.equal(
        "total" in published,
        false,
        "no coerced denominator may survive"
      );
      assert.equal(
        violations.length,
        1,
        "the invariant failure must be observable, not silent"
      );
      assert.match(violations[0], UNCOUNTABLE_LOG);
      assert.match(violations[0], REBUILD_PHASE_LOG);
    });
  }

  test("101 of 100 is not published as 100 of 100", () => {
    // The review's own example, asserted against the exact clamped value the
    // old `Math.min` produced. This is the test that goes red if the clamp
    // comes back.
    const { state } = liveRebuild();

    state.setPhaseProgress(GENERATION, MaintenancePhase.Rebuild, {
      processed: 101,
      total: 100,
    });

    const published = state.read();
    assert.notDeepEqual(published, {
      active: true,
      phase: MaintenancePhase.Rebuild,
      processed: 100,
      total: 100,
    });
    assert.equal(
      Reflect.get(published, "processed"),
      undefined,
      "a rejected report must leave no numerator behind"
    );
  });

  test("an uncountable report discards a previously published population", () => {
    // A producer that has just reported something impossible has forfeited its
    // claim on this phase's numbers. Keeping the last good pair on screen would
    // present a stale value as current.
    const { state, violations } = liveRebuild();
    state.setPhaseProgress(GENERATION, MaintenancePhase.Rebuild, {
      processed: 5,
      total: 100,
    });

    state.setPhaseProgress(GENERATION, MaintenancePhase.Rebuild, {
      processed: 101,
      total: 100,
    });

    assert.deepEqual(state.read(), {
      active: true,
      phase: MaintenancePhase.Rebuild,
    });
    assert.equal(violations.length, 1);
  });

  test("a superseded generation neither publishes nor logs", () => {
    // The generation guard runs FIRST: a cancelled window's bad report is not
    // this phase's invariant breach and must not raise one.
    const violations: string[] = [];
    const state = createMaintenanceProgressState(() => false, {
      logInvariantViolation: (message) => violations.push(message),
    });

    state.setPhase(GENERATION, MaintenancePhase.Rebuild);
    state.setPhaseProgress(GENERATION, MaintenancePhase.Rebuild, {
      processed: 101,
      total: 100,
    });

    assert.deepEqual(state.read(), { active: false, phase: null });
    assert.deepEqual(violations, []);
  });

  test("a report for a phase that is no longer on air neither publishes nor logs", () => {
    const { state, violations } = makeState();
    state.setPhase(GENERATION, MaintenancePhase.ArtifactLinks);

    state.setPhaseProgress(GENERATION, MaintenancePhase.Rebuild, {
      processed: 101,
      total: 100,
    });

    assert.deepEqual(state.read(), {
      active: true,
      phase: MaintenancePhase.ArtifactLinks,
    });
    assert.deepEqual(violations, []);
  });
});

/**
 * ISS-6241 (thadeusb review) — `setPhase` drops counts on EVERY publish, which
 * is the guard behind two separate claims the module documents. Both were
 * reachable only through the re-drive integration suite, so removing the drop
 * left this module's own tests green.
 */
describe("createMaintenanceProgressState — counts are dropped on publish", () => {
  test("re-publishing the SAME phase clears the previous attempt's counts", () => {
    // How a caller starting a fresh attempt resets the numbers: the abandoned
    // attempt's population must not stay on screen while attempt 2 works out
    // its own.
    const { state } = liveRebuild();
    state.setPhaseProgress(GENERATION, MaintenancePhase.Rebuild, {
      processed: 5,
      total: 100,
    });

    state.setPhase(GENERATION, MaintenancePhase.Rebuild);

    assert.deepEqual(
      state.read(),
      { active: true, phase: MaintenancePhase.Rebuild },
      "a re-published phase starts indeterminate, not on the old population"
    );
  });

  test("advancing the phase does not carry the rebuild's population onto it", () => {
    // The artifact-link pass has no progress channel, so a count surviving the
    // advance could only be the rebuild's population mislabelled.
    const { state } = liveRebuild();
    state.setPhaseProgress(GENERATION, MaintenancePhase.Rebuild, {
      processed: 412,
      total: 1299,
    });

    state.setPhase(GENERATION, MaintenancePhase.ArtifactLinks);

    assert.deepEqual(state.read(), {
      active: true,
      phase: MaintenancePhase.ArtifactLinks,
    });
  });

  test("clear() returns a counted phase to idle", () => {
    const { state } = liveRebuild();
    state.setPhaseProgress(GENERATION, MaintenancePhase.Rebuild, {
      processed: 412,
      total: 1299,
    });

    state.clear();

    assert.deepEqual(state.read(), { active: false, phase: null });
  });
});

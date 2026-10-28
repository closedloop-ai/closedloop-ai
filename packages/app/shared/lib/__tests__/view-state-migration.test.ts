import { describe, expect, it } from "vitest";
import {
  runViewStateMigration,
  type ViewStateMigrationSpec,
} from "../view-state-migration";

/**
 * ISS-9447 M3 — the shared step runner the three persisted view-state
 * migrations now go through.
 *
 * Division of labour: this lane owns the RUNNER's own rules (which steps run,
 * what the result is stamped with, what a future stamp becomes). Each axis's
 * own repair is covered where it lives — `sessions-saved-view-migration.test.ts`
 * and `agents-saved-view-migration.test.ts` — and those suites are what prove
 * the absorption changed no behaviour.
 */

/** A trivially observable step payload: each step appends its own marker. */
function appendingStep(version: number): {
  version: number;
  apply: (value: string[]) => string[];
} {
  return { apply: (value) => [...value, `v${version}`], version };
}

function threeStepSpec(): ViewStateMigrationSpec<string[]> {
  return {
    currentVersion: 3,
    steps: [appendingStep(1), appendingStep(2), appendingStep(3)],
  };
}

describe("runViewStateMigration", () => {
  it("applies only the steps the stored stamp has not taken", () => {
    const result = runViewStateMigration(threeStepSpec(), ["stored"], 1);

    // v1 is skipped (already taken); v2 and v3 run, in declaration order.
    expect(result.value).toEqual(["stored", "v2", "v3"]);
    expect(result.version).toBe(3);
  });

  it("applies every step to a never-migrated view", () => {
    const result = runViewStateMigration(threeStepSpec(), [], 0);

    expect(result.value).toEqual(["v1", "v2", "v3"]);
    expect(result.version).toBe(3);
  });

  it("runs no step for a view already at the current version", () => {
    // The "not fought on every load" promise every one of these migrations
    // makes: guarded on the VERSION, never on whether the payload looks
    // un-repaired, so a reader who undid a repair by hand keeps that.
    const result = runViewStateMigration(threeStepSpec(), ["stored"], 3);

    expect(result.value).toEqual(["stored"]);
    expect(result.version).toBe(3);
  });

  it("PRESERVES a stamp from a newer build, so its repair is never re-run", () => {
    // Unconditional since ISS-9447 M3 deleted the per-axis policy: the only
    // other answer, lowering the stamp so every step runs again, was ISS-6065's
    // clamp, and D1 removed the erasure it healed. A payload that goes back to
    // this build's defaults by a RESET is answered where the reset writes
    // (`resetColumnVersions`), not by re-running steps on load.
    const result = runViewStateMigration(threeStepSpec(), ["stored"], 9);

    expect(result.value).toEqual(["stored"]);
    expect(result.version).toBe(9);
  });

  it("stamps a view with nothing to repair, so the next load skips the check", () => {
    const result = runViewStateMigration(
      { currentVersion: 2, steps: [] },
      ["stored"],
      0
    );

    expect(result.value).toEqual(["stored"]);
    expect(result.version).toBe(2);
  });
});

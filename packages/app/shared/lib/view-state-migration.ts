/**
 * The one-time-repair runner every persisted view-state axis migrates through
 * (ISS-9447 M3).
 *
 * Three step tables existed before this module — Sessions' hidden-columns
 * table, Sessions' column-order relocation, and the Agents sort rewrite — each
 * re-deriving the same three rules from scratch: apply only the steps a stored
 * view has not taken, stamp the result at this build's version, and decide what
 * to do with a stamp from a build newer than this one. Two of them agreed on
 * the third rule and one did not, which is the drift this collapses.
 *
 * ## Guarded on the VERSION, never on the payload
 *
 * A step runs because the stored stamp is below it, not because the value looks
 * un-repaired. That is what keeps the promise every one of these migrations
 * makes in its own words: a reader who undoes a repair by hand is not fought on
 * the next load.
 *
 * ## A stamp from a NEWER build is kept verbatim
 *
 * Never lowered to this build's version, so a repair this build has never seen
 * is not silently re-run against a view that already took it. ISS-6065 lowered
 * it on the Sessions hidden-columns axis, to answer a restore that DESTROYED
 * part of the value and left the stamp swearing the repair had run; ISS-9447 D1
 * removed that erasure and M3 removed the lowering with it.
 *
 * A RESET is the other way a stored payload goes back to this build's defaults,
 * and healing that here would be the same clamp again — re-hiding, on every
 * load, a column the reader deliberately re-showed on a newer build. It is
 * answered at the write instead: whoever rewrites the payload rewrites the
 * stamp describing it (`resetColumnVersions` on the shared persisted-view
 * hook).
 */

/**
 * One repair, and the stamp a view carries once it has taken it.
 *
 * `version` is FROZEN at the value the step shipped with, never read from the
 * axis's current version: a step whose version rose with the axis would re-run
 * against every view that already took it, which is the "not fought on every
 * load" promise broken.
 */
export type ViewStateMigrationStep<TValue> = {
  version: number;
  apply: (value: TValue) => TValue;
};

export type ViewStateMigrationSpec<TValue> = {
  /** The stamp a view carries once every step has been applied to it. */
  currentVersion: number;
  /** In ascending version order; a step is applied when the stored stamp is below it. */
  steps: readonly ViewStateMigrationStep<TValue>[];
};

/**
 * Apply every step `fromVersion` has not taken, and report the stamp the result
 * should be re-persisted with.
 *
 * A view already at `currentVersion` or beyond is returned untouched, and keeps
 * the stamp it arrived with — including one a newer build wrote. A view below it
 * takes the pending steps in declaration order and is stamped `currentVersion` —
 * an empty value still advances, because there is nothing to repair and stamping
 * means the next load skips the check rather than re-deriving the same no-op.
 */
export function runViewStateMigration<TValue>(
  spec: ViewStateMigrationSpec<TValue>,
  value: TValue,
  fromVersion: number
): { value: TValue; version: number } {
  if (fromVersion >= spec.currentVersion) {
    return { value, version: fromVersion };
  }
  let migrated = value;
  for (const step of spec.steps) {
    if (fromVersion < step.version) {
      migrated = step.apply(migrated);
    }
  }
  return { value: migrated, version: spec.currentVersion };
}

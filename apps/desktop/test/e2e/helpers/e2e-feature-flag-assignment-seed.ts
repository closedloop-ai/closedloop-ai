import fs from "node:fs";
import path from "node:path";
import {
  E2E_FEATURE_FLAG_ASSIGNMENT_FILE,
  e2eFeatureFlagAssignmentSeedSchema,
} from "../../../src/shared/e2e-feature-flag-assignment-contract.js";

/**
 * ISS-8753 — write this launch's feature-flag ASSIGNMENT into the profile.
 *
 * The companion to `desktop-app.ts`'s `desktop-settings.json` merge, and the
 * half that survives the PostHog cutover. Desktop flag resolution is the
 * signed-in user's server-side assignment; the Electron harness launches with no
 * account, so without a seeded assignment every gate in every spec is closed.
 * The main process serves this file back over IPC in the real wire shape, gated
 * on the harness launch argument and refused outright in a packaged build.
 *
 * Declared here rather than in `desktop-app.ts` for the same reason
 * `E2E_DESKTOP_SETTINGS_SEED` is: no Playwright import in its closure, so a
 * `test:node` suite can drive the real writer and assert what a launched app
 * would be served.
 *
 * READ-MERGE-WRITE, so callers layer rather than overwrite — the standard seed
 * runs first and a spec's `beforeLaunch` adds to it, exactly as the settings
 * merge behaves.
 *
 * THE READ IS RECOVERED FROM; THE WRITE IS DELIBERATELY FATAL (davetho review
 * on PR #6411). An unreadable or malformed PRIOR seed is recoverable — this
 * helper's job is to end with a seed the reader accepts, and it can still do
 * that by starting from nothing — so {@link readSeededFlags} swallows it. A
 * failed `writeFileSync` is not: it means the state the spec depends on was
 * never established, and catching it would let the launch proceed unseeded so
 * the spec failed later on its real assertion ("the Help link is not visible"),
 * which reads as a product regression and sends the next person hunting the
 * gate instead of the disk. The filesystem error at the point of failure is the
 * honest signal, so it is left to propagate.
 */
export function mergeE2eFeatureFlagAssignment(
  userDataDir: string,
  flags: Record<string, boolean>
): void {
  const seedPath = path.join(userDataDir, E2E_FEATURE_FLAG_ASSIGNMENT_FILE);
  fs.writeFileSync(
    seedPath,
    JSON.stringify(
      { flags: { ...readSeededFlags(seedPath), ...flags } },
      null,
      2
    ),
    "utf8"
  );
}

/**
 * The verdicts already seeded for this profile, or none.
 *
 * A profile with no seed yet is the common case (the standard seed writes
 * first), and an absent, unreadable, truncated, malformed, or wrong-shaped one
 * is treated the SAME way: the merge starts from nothing. None of THESE throws
 * inside a `beforeLaunch`, which would fail the spec with a filesystem error
 * instead of the assertion it came for.
 *
 * Scoped to the READ, deliberately. The subsequent write is NOT covered by this
 * promise and is meant to throw — see {@link mergeE2eFeatureFlagAssignment} for
 * why a seed that cannot be established is a louder failure than one that is
 * silently skipped.
 *
 * Validated with the schema the main-process reader uses, not a looser local
 * check, so this can never layer a prior seed forward that the reader would
 * then reject whole — which would close every gate in the spec rather than the
 * one key that was wrong.
 */
function readSeededFlags(seedPath: string): Record<string, boolean> {
  const parsed = e2eFeatureFlagAssignmentSeedSchema.safeParse(
    readSeedPayload(seedPath)
  );
  return parsed.success ? parsed.data.flags : {};
}

/**
 * The seed file's decoded contents, or `null` when there is nothing to decode.
 *
 * The read and the decode share one `catch` deliberately: a missing file, a
 * permissions error, and a half-written one from an interrupted prior write are
 * all "no prior seed", and none of them is a reason to abort the launch. No
 * `existsSync` pre-check — it would answer a question this `catch` already
 * covers, and answer it about a moment that has passed by the time the read
 * runs.
 */
function readSeedPayload(seedPath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(seedPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * ISS-9728 — take this launch's harness assignment away, so the renderer falls
 * through to the REAL assignment path.
 *
 * THE ONE DELIVERY A SEED CANNOT PRODUCE. Every payload this helper's sibling
 * can write is an answer that ARRIVED — `Assigned` for a well-formed one,
 * `Malformed` for a broken one — because the renderer runs the same boundary
 * read over a seed as over a real reply. `Unavailable` is the shape a launch
 * with NO IDENTITY produces, and the renderer only reaches it after the seam
 * answers "no seed at all" and the signed-out branch of
 * `desktop-posthog-flag-assignment.ts` runs. So a spec whose subject is the
 * unauthenticated reader has to remove the file, not write a different one.
 *
 * It is not enough to decline to seed flags of your own: `launchDesktopApp`
 * writes `E2E_DESKTOP_FEATURE_FLAG_SEED` on EVERY launch, so an
 * un-opinionated signed-out profile is still served an assignment and reports a
 * settled program it was never asked about.
 *
 * Call it from a spec's `beforeLaunch`, which runs AFTER that standard seed. It
 * takes every other harness gate with it, so it belongs only to specs whose
 * surface is ungated — the Dashboard and its tour are; Labs and Agents are not.
 *
 * `force`, because the postcondition is "this profile has no seed", and a
 * profile that never had one already satisfies it.
 */
export function clearE2eFeatureFlagAssignment(userDataDir: string): void {
  fs.rmSync(path.join(userDataDir, E2E_FEATURE_FLAG_ASSIGNMENT_FILE), {
    force: true,
  });
}

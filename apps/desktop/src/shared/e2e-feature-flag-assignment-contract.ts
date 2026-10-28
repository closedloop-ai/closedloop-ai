/**
 * ISS-8753 — how the Electron E2E flag-assignment seam is spelled: the two
 * names and the seed file's shape, shared by the main process that READS the
 * seed and the Playwright harness that WRITES it.
 *
 * Kept clear of `@repo/*` TS subpaths and of every main-process module on
 * purpose. The harness helper that writes the seed file is loaded by the
 * Playwright spec runner, where those subpaths resolve without extensions in
 * the app but not under the spec loader, and a load failure aborts the WHOLE
 * E2E suite rather than reddening one spec (see `apps/desktop/test/AGENTS.md` →
 * "Import hazard"). A bare npm package is not that hazard — `zod` below is
 * already loaded under this same spec loader by the e2e helpers.
 *
 * The BEHAVIOR these gate — which launches are served a seed at all — lives in
 * `main/lifecycle/e2e-feature-flag-assignment.ts` and stays there. What lives
 * here is only what both sides must agree on, so the two cannot drift.
 */
import { z } from "zod";

/**
 * The launch argument that opts a launch into being served a harness-seeded
 * feature-flag assignment. No shipped launcher passes it, and a packaged build
 * ignores it outright — the same posture as `E2E_NO_REVEAL_ARG` and
 * `E2E_EPHEMERAL_LOOPBACK_PORTS_ARG`.
 */
export const E2E_FEATURE_FLAG_ASSIGNMENT_ARG = "--e2e-feature-flag-assignment";

/**
 * The file inside the launch profile (`--user-data-dir`) holding this launch's
 * per-key verdicts, as `{ "flags": { "<key>": true } }`.
 *
 * A SIBLING of `desktop-settings.json` rather than a key inside it: the point of
 * ISS-8753 is that a persisted setting no longer decides a flag, so the harness
 * seed must not look like one.
 */
export const E2E_FEATURE_FLAG_ASSIGNMENT_FILE =
  "e2e-feature-flag-assignment.json";

/**
 * The payload shape of {@link E2E_FEATURE_FLAG_ASSIGNMENT_FILE}.
 *
 * ONE schema for both sides, because the writer read-merge-writes the same file
 * the reader serves from: two copies could drift into a state where the harness
 * layers a prior seed forward that the main process then rejects WHOLE, closing
 * every gate in every spec instead of the one key that was wrong.
 *
 * A verdict is a BOOLEAN and the record is closed over that — a non-boolean is
 * not a partially-usable assignment, it is a seed neither side trusts. Neither
 * side throws on a seed that fails this: the harness merge starts from nothing,
 * the main-process read serves nothing and the renderer falls through to the
 * real assignment path.
 */
export const e2eFeatureFlagAssignmentSeedSchema = z.object({
  flags: z.record(z.string(), z.boolean()),
});

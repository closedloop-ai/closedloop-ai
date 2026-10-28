import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { collectTokenSurfaceMatches } from "./support/token-surface-scan.js";

/**
 * The BUILT-output half of the PostHog token/client scan (ISS-6367).
 *
 * Split out of `no-token-surface.test.ts` because that file's built-output scan
 * was `existsSync`-guarded: it read `apps/desktop/dist` only when the directory
 * happened to be there, and once `desktop-node` / `desktop-renderer` moved to
 * `build:prereqs` no lane that runs it compiles a bundle any more. A forbidden
 * client or token introduced DURING bundling — the case the artifact scan
 * exists for, and the one source scanning cannot see — then passed the
 * pre-merge gate by scanning nothing.
 *
 * So this file is excluded from the census (`EXCLUDED_TEST_FILES`) and run by
 * its own script, `pnpm --filter desktop run test:dist-token-surface`, from the
 * one lane that does compile: `desktop-build`, immediately after `Build
 * desktop`. A MISSING artifact fails here rather than skipping — that is the
 * half that stops the same silent no-op coming back the next time a lane drops
 * its build step. `scripts/lint/desktop-lane-fanout.test.ts` pins the wiring, so
 * deleting the workflow step reds a guard instead of the scan going quiet.
 */
const repoRoot = path.resolve(import.meta.dirname, "../../..");

const DESKTOP_DIST = "apps/desktop/dist";

/**
 * Produced by `pnpm --filter desktop run package` (electron-builder) and by
 * `desktop-packaging-validation.yml`, neither of which runs any desktop suite —
 * so in CI this path is never present and the scan below only bites locally,
 * after a full package. Kept optional deliberately: making it required would
 * fail `desktop-build`, which does not package.
 */
const PACKAGED_ASAR =
  "apps/desktop/dist-dmg/mac-universal/Closedloop.app/Contents/Resources/app.asar";

test("built Electron bundle contains no direct PostHog token/client contract", () => {
  const distPath = path.join(repoRoot, DESKTOP_DIST);
  assert.ok(
    existsSync(distPath),
    `${DESKTOP_DIST} is missing, so this scan would read nothing. Run this suite only after \`pnpm --filter desktop run build\` — in CI that is the \`desktop-build\` job, after its \`Build desktop\` step.`
  );

  const matches: string[] = [];
  collectTokenSurfaceMatches(distPath, DESKTOP_DIST, matches);

  const asarPath = path.join(repoRoot, PACKAGED_ASAR);
  if (existsSync(asarPath)) {
    collectTokenSurfaceMatches(asarPath, PACKAGED_ASAR, matches);
  }

  assert.deepEqual(matches, []);
});

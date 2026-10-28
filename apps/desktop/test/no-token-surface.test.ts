import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vitest";
import {
  collectTokenSurfaceMatches,
  DESKTOP_SOURCE_SCAN_ROOTS,
} from "./support/token-surface-scan.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

/**
 * SOURCE surfaces only. The BUILT-output half of this scan lives in
 * `no-token-surface-dist.test.ts`, which `desktop-build` runs after the bundle
 * compiles (ISS-6367): every lane that runs THIS file is now on `build:prereqs`,
 * so an `existsSync`-guarded `apps/desktop/dist` scan here would find no
 * directory and pass having read nothing.
 *
 * DESKTOP surfaces only, since ISS-9219. The `.github` root this used to carry
 * is scanned by `scripts/deploy/no-token-surface-github.test.ts`, from a lane
 * whose path filter covers the whole directory — the roots below are all under
 * `apps/desktop/**`, which is what the `desktop` filter gating this lane
 * actually watches.
 */
test("Electron package and source surfaces contain no direct PostHog token/client contract", () => {
  const matches: string[] = [];
  for (const relativePath of DESKTOP_SOURCE_SCAN_ROOTS) {
    collectTokenSurfaceMatches(
      path.join(repoRoot, relativePath),
      relativePath,
      matches
    );
  }
  assert.deepEqual(matches, []);
});

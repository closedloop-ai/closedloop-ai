/**
 * ISS-5146: the surviving coverage from the orphaned `apps/desktop/e2e/
 * distribution-flow.spec.ts`, moved under the configured `testDir` so it
 * actually runs.
 *
 * FEA-2923 / T-16.4 retired the standalone Skills, Tools, and SubAgents Lab
 * views into the unified Agents workspace, keeping their hashes as aliases so
 * old bookmarks degrade gracefully. `route-table.test.ts` pins the mapping at
 * the unit level (`matchRoute("/skills") → NavId.Agents`); what it cannot pin is
 * that the SHELL honors it — that a legacy hash typed into the running renderer
 * actually resolves and mounts the Agents workspace instead of dead-ending.
 * That is what this spec covers, and it is the reason the alias tests were
 * ported rather than deleted with the rest of their file.
 *
 * Everything else in that file was dropped rather than moved, because moving it
 * would have re-asserted retired or unfalsifiable contracts:
 *   - Its Packs-Lab nav assertions ("no `Packs` link", "`/packs` renders the
 *     Agents view") were REVERSED by FEA-4087, which reclaimed `/packs` for the
 *     real top-level Packs page. `all-views-smoke.spec.ts` now asserts the
 *     opposite, correct behavior.
 *   - Its distribution auto-install test is `test.fixme` — it never ran anywhere.
 *   - Its "installer is a no-op when offline" test could not fail: the fake API
 *     server's origin was never handed to the app, so it could not have received
 *     a request under any behavior, and the absence was "proved" by a fixed
 *     sleep, which AGENTS.md bans.
 *   - Its Agents-workspace mount test is covered by `all-views-smoke.spec.ts`.
 *
 * One launch drives all three aliases: each is a hash navigation in the same
 * renderer, and the original file paid for a full Electron launch per assertion.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, test } from "@playwright/test";
import {
  breadcrumbNav,
  gotoNav,
  launchDesktopApp,
} from "./helpers/desktop-app";

/** The retired Packs-Lab nav ids that still alias onto the Agents workspace. */
const LEGACY_AGENTS_ALIASES = ["skills", "tools", "subagents"] as const;

test("legacy Packs-Lab hashes still land on the Agents workspace", async () => {
  const { page, pageErrors, cleanup } = await launchDesktopApp({
    userDataPrefix: "desktop-legacy-nav-aliases-e2e-",
  });

  try {
    for (const alias of LEGACY_AGENTS_ALIASES) {
      // Navigate somewhere else first so the Agents breadcrumb from the
      // PREVIOUS alias cannot satisfy this iteration's assertion — a stale DOM
      // would otherwise make every alias after the first vacuously green.
      await gotoNav(page, "dashboard");
      await expect(
        breadcrumbNav(page).getByText("Dashboard", { exact: true })
      ).toBeVisible({ timeout: 30_000 });

      await gotoNav(page, alias);

      await expect(
        breadcrumbNav(page).getByText("Agents", { exact: true }),
        `#/${alias} should resolve to the Agents workspace`
      ).toBeVisible({ timeout: 30_000 });
    }

    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
  }
});

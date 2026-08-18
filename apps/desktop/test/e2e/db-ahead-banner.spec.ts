/**
 * E2E regression (ISS-4714): the DB-ahead-of-app "update required" banner, proven
 * through the LAUNCHED app.
 *
 * The renderer render test and the boundary round-trip test cover the pieces in
 * isolation, but neither launches Electron and flows a real DB-ahead migration
 * history through the main-process db-host → runtime-status IPC → the mounted
 * banner. This spec closes that gap (the launched-app regression `apps/desktop/
 * AGENTS.md` requires for a UI bug fix):
 *
 *   1. Launch once to create + migrate the SQLite store, confirm the migration
 *      tracking table landed, and close.
 *   2. While the app is DOWN, record a fictional FUTURE migration as applied —
 *      exactly the "store created by a newer Desktop build" condition.
 *   3. Relaunch the SAME profile. The boot migration runner refuses to open the
 *      ahead DB (Downgrade), and the renderer must surface the DB-ahead banner
 *      with its update-check action — WITHOUT crashing the app.
 *
 * Would fail before the fix: the refusal thrown in the db-host `utilityProcess`
 * lost its `kind` crossing the structured-clone boundary, so the main-side
 * classifier never flagged `dbAhead` and the banner stayed hidden even though the
 * in-process unit test passed.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  seedFutureMigrationRow,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

/**
 * ISS-4792: the `db-ahead-banner` Labs flag key, pinned as a literal rather than
 * imported from `src/shared/feature-flags`.
 *
 * That module is main-process code and imports `@repo/api/src/types/...` — an
 * extension-less TypeScript subpath of a workspace package. Vite/vitest resolve
 * it, but Playwright's Node loader does not: importing the registry from a spec
 * aborts the WHOLE Electron e2e run at load time with "Cannot find module
 * .../apps/desktop/node_modules/@repo/api/src/types/sessions-status-pill-sync-state-flag",
 * before any test executes. The sibling e2e spec (`sessions-quarantine-caveat`)
 * passes its flag keys as literals for the same reason.
 *
 * Drift is caught: `test/feature-flags.test.ts` asserts the registry defines
 * this exact key, and if the seed below ever named a key the registry does not
 * register, the banner would stay gated and this spec would fail loudly.
 */
const DB_AHEAD_BANNER_FLAG_KEY = "db-ahead-banner";
/**
 * ISS-4834: a substring of `DB_AHEAD_BANNER_MESSAGE`, pinned as a literal for
 * the same loader reason as the flag key above - the banner module pulls in
 * `@closedloop-ai/design-system` and the renderer hooks, which Playwright's Node loader
 * cannot resolve, and one bad import aborts the entire Electron suite at load.
 *
 * Drift is caught in `src/renderer/components/__tests__/
 * agent-monitor-db-ahead-banner.test.tsx`, which asserts the exported message
 * still contains this exact phrase.
 */
const DB_AHEAD_BANNER_COPY = /saved by a newer version of this app/i;
const CHECK_FOR_UPDATES_LABEL = /check for updates/i;

test.describe("Agent Monitor DB-ahead banner", () => {
  test("surfaces the update-required banner when the local DB is ahead of the app", async () => {
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-db-ahead-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-db-ahead-udd-")
    );

    try {
      // Launch 1 — create + migrate the schema, confirm it landed, close. An
      // isolated CODEX_HOME keeps the operator's real sessions out of the run.
      const first = await launchDesktopApp({
        env: { CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      // Record a FUTURE migration as applied while the app is DOWN — the store
      // now looks like it was created by a newer Desktop build.
      await seedFutureMigrationRow(userDataDir);

      // Launch 2 — the boot migration runner refuses the ahead DB; the renderer
      // must surface the DB-ahead banner (not crash, not silently run degraded).
      // ISS-4792 (ISS-4779 closed-by-default): the banner is behind the
      // `db-ahead-banner` Labs flag, which a fresh profile resolves OFF. Seed it
      // ON for this spec so the regression still exercises the banner rather
      // than silently asserting the gate.
      const { app, page, cleanup } = await launchDesktopApp({
        beforeLaunch: (launchUserDataDir) => {
          seedDesktopFeatureFlags(launchUserDataDir, {
            [DB_AHEAD_BANNER_FLAG_KEY]: true,
          });
        },
        env: { CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        // The banner is an app-level status row, visible regardless of tab.
        await expect(page.getByText(DB_AHEAD_BANNER_COPY)).toBeVisible({
          timeout: 30_000,
        });
        // The highest-severity banner offers a recovery action, not a mute state.
        await expect(
          page.getByRole("button", { name: CHECK_FOR_UPDATES_LABEL })
        ).toBeVisible();
        // The app itself stays up — a boot DB failure disables DB IPC but must
        // never crash the process.
        expect(app.windows().length).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(codexHome, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

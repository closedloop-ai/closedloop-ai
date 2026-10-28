/**
 * E2E acceptance check (ISS-6758): the Diagnostics -> Coverage tab, driven
 * through the LAUNCHED app so the wiring the component test cannot see is
 * actually exercised: the GROUP BY over `session_activity_metrics`, the
 * IPC/preload hop that carries `activityCoverage` into the renderer, and the
 * flag gate in BOTH directions.
 *
 * The component test injects a payload directly, so it proves the rendering and
 * nothing about how the payload arrives — which is precisely the defect this
 * ticket fixes: before it, the only cohort read in the repo lived in a test.
 *
 * The profile here is a fresh one with no ingested sessions, which is the honest
 * primary flow for a first launch: nothing has been rolled up, so the tab must
 * say so rather than report 0% coverage as a measured result.
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
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";

const DIAGNOSTICS_HEADING = "Diagnostics";
const COVERAGE_TAB_NAME = "Coverage";
const NOTHING_ROLLED_UP_TEXT = /No session has been rolled up yet/;
const UNAVAILABLE_TEXT = /Coverage unavailable/;

test.describe("Diagnostics coverage tab (ISS-6758)", () => {
  test("is reachable behind its feature flag and reports an empty corpus honestly", async () => {
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-coverage-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-coverage-codex-")
    );
    let cleanup: (() => Promise<void>) | undefined;

    try {
      const launched = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataPrefix: "desktop-coverage-on-e2e-",
        beforeLaunch: (userDataDir) => {
          seedDesktopFeatureFlags(userDataDir, {
            [DESKTOP_ACTIVITY_COVERAGE_DIAGNOSTICS_FEATURE_FLAG_KEY]: true,
          });
        },
      });
      cleanup = launched.cleanup;
      const { page, pageErrors } = launched;

      await gotoNav(page, "diagnostics");
      await expect(
        page.getByRole("heading", { name: DIAGNOSTICS_HEADING })
      ).toBeVisible({ timeout: 20_000 });

      const coverageTab = page.getByRole("tab", { name: COVERAGE_TAB_NAME });
      await expect(coverageTab).toBeVisible({ timeout: 20_000 });
      await coverageTab.click();

      // "Sessions counted" only renders once the payload crossed IPC, so this
      // proves the read ran — not merely that a tab trigger exists.
      await expect(page.getByText("Sessions counted")).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText(NOTHING_ROLLED_UP_TEXT)).toBeVisible({
        timeout: 20_000,
      });
      // The read RAN and found nothing — a different claim from it having
      // failed. Asserting the absence of the failure copy is what keeps a
      // silently broken read from passing this test.
      await expect(page.getByText(UNAVAILABLE_TEXT)).toHaveCount(0);

      expect(pageErrors).toEqual([]);
    } finally {
      try {
        await cleanup?.();
      } finally {
        fs.rmSync(claudeHome, { recursive: true, force: true });
        fs.rmSync(codexHome, { recursive: true, force: true });
      }
    }
  });

  test("is absent when its Labs flag is off, so the gate closes by default", async () => {
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-coverage-off-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-coverage-off-codex-")
    );
    let cleanup: (() => Promise<void>) | undefined;

    try {
      // No flag seeding at all: the product default must be OFF (ISS-4779
      // closed-by-default). A gate that only closes when explicitly disabled
      // is not closed by default.
      const launched = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataPrefix: "desktop-coverage-off-e2e-",
      });
      cleanup = launched.cleanup;
      const { page, pageErrors } = launched;

      await gotoNav(page, "diagnostics");
      await expect(
        page.getByRole("heading", { name: DIAGNOSTICS_HEADING })
      ).toBeVisible({ timeout: 20_000 });

      // The sibling tabs are present, which proves Diagnostics itself rendered
      // and the absence below is the gate rather than a failed page load.
      await expect(page.getByRole("tab", { name: "Gateway Logs" })).toBeVisible(
        { timeout: 20_000 }
      );
      await expect(
        page.getByRole("tab", { name: COVERAGE_TAB_NAME })
      ).toHaveCount(0);

      expect(pageErrors).toEqual([]);
    } finally {
      try {
        await cleanup?.();
      } finally {
        fs.rmSync(claudeHome, { recursive: true, force: true });
        fs.rmSync(codexHome, { recursive: true, force: true });
      }
    }
  });
});

/**
 * Declared locally rather than imported from `src/shared/feature-flags.ts`.
 *
 * That module pulls the whole registry, which reaches `@repo/api` subpaths that
 * do not resolve under Playwright's transform here. Importing it does not fail
 * this spec, it aborts COLLECTION for the entire desktop suite (`Total: 0 tests
 * in 0 files`), which reads as a red with no failing test. The sibling specs
 * declare their flag keys the same way for the same reason; this copy is pinned
 * against the registry constant in `feature-flags-shared-ui.test.ts`.
 */
const DESKTOP_ACTIVITY_COVERAGE_DIAGNOSTICS_FEATURE_FLAG_KEY =
  "activity-coverage-diagnostics";

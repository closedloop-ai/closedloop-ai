/**
 * E2E acceptance check (ISS-5266): the Diagnostics -> Withheld tab, driven
 * through the LAUNCHED app so the wiring the component test cannot see is
 * actually exercised: the db-host read, the IPC/preload hop that carries
 * `opencodeWithheld` and `opencodeWithheldScans` into the renderer, and the
 * Labs gate in BOTH directions.
 *
 * The component test injects a payload directly, so it proves the rendering and
 * nothing about how the payload arrives. That was the gap raised in review on
 * this PR.
 *
 * The profile here is a fresh one with no OpenCode store, which is the honest
 * primary flow for a first launch: nothing has completed a scan, so the tab must
 * say so rather than claim the corpus is complete. That is the exact conflation
 * this ticket exists to remove, so it is the state worth pinning end to end.
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
const WITHHELD_TAB_NAME = "Withheld";
const NOT_SCANNED_TEXT = /No OpenCode store has reported yet/;
const COMPLETE_CLAIM_TEXT = /No subagent sessions are currently withheld/;
const WITHHELD_REGION_NAME = /Withheld OpenCode Subagents/;

test.describe("Diagnostics withheld tab (ISS-5266)", () => {
  test("is reachable behind its Labs flag and reports an unscanned store as unknown", async () => {
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-withheld-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-withheld-codex-")
    );
    let cleanup: (() => Promise<void>) | undefined;

    try {
      const launched = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataPrefix: "desktop-withheld-on-e2e-",
        beforeLaunch: (userDataDir) => {
          seedDesktopFeatureFlags(userDataDir, {
            [DESKTOP_OPENCODE_WITHHELD_DIAGNOSTICS_FEATURE_FLAG_KEY]: true,
          });
        },
      });
      cleanup = launched.cleanup;
      const { page, pageErrors } = launched;

      await gotoNav(page, "diagnostics");
      await expect(
        page.getByRole("heading", { name: DIAGNOSTICS_HEADING })
      ).toBeVisible({ timeout: 20_000 });

      const withheldTab = page.getByRole("tab", { name: WITHHELD_TAB_NAME });
      await expect(withheldTab).toBeVisible({ timeout: 20_000 });
      await withheldTab.click();

      // The region name proves the payload crossed IPC and the tab rendered its
      // card, not merely that a tab trigger exists.
      const region = page.getByRole("region", {
        name: WITHHELD_REGION_NAME,
      });
      await expect(region).toBeVisible({ timeout: 20_000 });

      // No store has scanned, so the only honest answer is unknown. Asserting
      // the ABSENCE of the completeness claim is the load-bearing half: a
      // regression that collapses "nothing scanned" back into "nothing
      // withheld" would still show a tab and still look fine.
      await expect(region).toContainText(NOT_SCANNED_TEXT, { timeout: 20_000 });
      await expect(region).not.toContainText(COMPLETE_CLAIM_TEXT);

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
      path.join(os.tmpdir(), "desktop-withheld-off-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-withheld-off-codex-")
    );
    let cleanup: (() => Promise<void>) | undefined;

    try {
      // No flag seeding at all: the product default must be OFF (ISS-4779
      // closed-by-default). A gate that only closes when explicitly disabled
      // is not closed by default.
      const launched = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataPrefix: "desktop-withheld-off-e2e-",
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
        page.getByRole("tab", { name: WITHHELD_TAB_NAME })
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
 * declare their flag keys the same way for the same reason; keep this string in
 * step with the registry entry it mirrors.
 */
const DESKTOP_OPENCODE_WITHHELD_DIAGNOSTICS_FEATURE_FLAG_KEY =
  "opencode-withheld-diagnostics";

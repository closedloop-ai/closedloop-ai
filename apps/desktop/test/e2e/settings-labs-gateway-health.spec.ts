/**
 * Native Settings navigation and the Desktop App panel's runtime-status bridge.
 * The backlogged-panel case also scans that native panel inside the launched
 * Settings modal for critical WCAG AA violations; it does not scan every panel.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import axe from "axe-core";
import { WCAG_AA_TAGS } from "../../../../packages/app/test/a11y/axe.ts";
import type { CloudReadReadinessSnapshot } from "../../src/shared/cloud-read-readiness-contract.js";
import {
  drainedCloudReadReadiness,
  gotoHash,
  gotoNav,
  identifiedCloudSyncProgress,
  launchDesktopApp,
  outstandingCloudReadReadiness,
  SETTINGS_SHELL_TEST_ID,
} from "./helpers/desktop-app";

const SETTINGS_SHELL_TIMEOUT_MS = 30_000;

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Window augmentation types the axe runtime injected into Electron.
  interface Window {
    axe: typeof axe;
  }
}

test.describe("Settings gateway health", () => {
  // ISS-4478: Settings is reachable through the real user path — the bottom-left
  // account menu — not only by writing location.hash via gotoNav. Open the
  // account menu, click Settings, and assert the Settings view actually renders
  // (whitlockk review: gotoNav bypassed the only user path this PR adds).
  test("opens Settings from the bottom-left account menu", async () => {
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-account-menu-settings-codex-home-")
    );
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-account-menu-settings-claude-home-")
    );
    let cleanupApp: (() => Promise<void>) | undefined;
    let cleanupError: unknown;

    try {
      const { cleanup, page, pageErrors } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataPrefix: "desktop-account-menu-settings-e2e-",
      });
      cleanupApp = cleanup;

      // Start away from Settings so the click is what navigates there.
      await gotoNav(page, "sessions");
      await expect(page.getByTestId(SETTINGS_SHELL_TEST_ID)).toHaveCount(0);

      await page.getByRole("button", { name: "Open account menu" }).click();
      await page
        .getByRole("menuitem", { name: "Settings", exact: true })
        .click();

      await expect(page.getByTestId(SETTINGS_SHELL_TEST_ID)).toBeVisible({
        timeout: SETTINGS_SHELL_TIMEOUT_MS,
      });
      expect(pageErrors).toEqual([]);
    } finally {
      if (cleanupApp) {
        try {
          await cleanupApp();
        } catch (error) {
          cleanupError = error;
        }
      }
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
    }
    expect(fs.existsSync(codexHome)).toBe(false);
    expect(fs.existsSync(claudeHome)).toBe(false);
    expect(cleanupError).toBeUndefined();
  });
});

/**
 * ISS-10575 — the gateway health rollup, Connection Status and the History Sync
 * cell, restored against Settings v2 → Labs → Desktop App.
 *
 * WHY THESE THREE ARE ONE CASE. They are one `ConnectionStatusSection` render:
 * the section heading, the `Gateway` cell it puts first, and the `History Sync`
 * cell it puts last. Splitting them would buy three Electron launches and prove
 * nothing a single mount does not.
 *
 * WHAT IS SUBSTITUTED. Only the readiness INPUT, via
 * `cloud-read-readiness-preload` — the real sampler answers UNKNOWN for the
 * first 60s of every launch, so no spec can wait it out. The runtime-status
 * handler, the preload bridge, `useCloudSyncBacklog` and the rendered cell are
 * the shipped ones, so this owns the chain from the payload OUT.
 * `test/runtime-status-cloud-backlog-wiring.test.ts` owns the half before it —
 * the main process putting the field on the payload. Neither is sufficient
 * alone.
 *
 * `identifiedCloudSyncProgress()` is what makes the History Sync label
 * observable at all: without a cloud identity the cell renders its dash and no
 * completeness label is reachable. The readiness snapshot decides WHICH label.
 *
 * THE EXPECTED STRINGS ARE RE-TYPED HERE ON PURPOSE. Importing
 * `describeGatewayHealth`'s table or `describeCloudSyncStatus`'s copy would make
 * the fixture agree with any mutation of the thing it is policing.
 */
test.describe("Settings Desktop App gateway health", () => {
  /** The panel's own `SettingsPanelSection` heading — proof the launch reached it. */
  const DESKTOP_APP_HEADING = "Desktop App";
  const CONNECTION_STATUS_HEADING = "Connection Status";
  const LAUNCHED_CELL_TIMEOUT_MS = 30_000;

  /**
   * Every (label, detail) pair `describeGatewayHealth` can produce, re-typed.
   * The pair is asserted whole rather than key-by-key so a mutant that keeps a
   * valid label beside another bucket's detail is caught.
   */
  const GATEWAY_ROLLUP_STATES = [
    {
      detail: "The local gateway is reachable and healthy.",
      label: "Connected",
    },
    {
      detail: "The local gateway is reachable but not reporting healthy.",
      label: "Needs Attention",
    },
    { detail: "The local gateway server is not reachable.", label: "Offline" },
  ];

  /** The value `<p>` is the sibling of its label `<p>`; read both cells the same way. */
  function statusCellValue(shell: Locator, label: string): Locator {
    return shell
      .getByText(label, { exact: true })
      .locator("xpath=./following-sibling::p[1]");
  }

  async function openDesktopAppPanel(
    readiness: CloudReadReadinessSnapshot,
    userDataPrefix: string
  ): Promise<{
    cleanup: () => Promise<void>;
    page: Page;
    pageErrors: Error[];
    shell: Locator;
  }> {
    const { cleanup, page, pageErrors } = await launchDesktopApp({
      cloudReadReadiness: readiness,
      cloudSyncProgress: identifiedCloudSyncProgress(),
      userDataPrefix,
    });
    try {
      await gotoHash(page, "/settings?panel=desktop-app");
      const shell = page.getByTestId(SETTINGS_SHELL_TEST_ID);
      await expect(shell).toBeVisible({ timeout: LAUNCHED_CELL_TIMEOUT_MS });
      await expect(
        shell.getByRole("heading", { name: DESKTOP_APP_HEADING })
      ).toBeVisible({ timeout: LAUNCHED_CELL_TIMEOUT_MS });
      return { cleanup, page, pageErrors, shell };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  test("carries Connection Status, the gateway rollup and a backlogged History Sync cell", async () => {
    test.setTimeout(120_000);
    const { cleanup, page, pageErrors, shell } = await openDesktopAppPanel(
      outstandingCloudReadReadiness(),
      "desktop-app-panel-gateway-rollup-"
    );
    try {
      await expect(
        shell.getByText(CONNECTION_STATUS_HEADING, { exact: true })
      ).toBeVisible({ timeout: LAUNCHED_CELL_TIMEOUT_MS });

      // The rollup's own value is not deterministic on a launched app — it
      // reports whether THIS machine's gateway came up — so what is pinned is
      // that the cell resolves to one of the three buckets with that bucket's
      // own hover detail, rather than to a fourth string or to nothing.
      const gatewayCell = statusCellValue(shell, "Gateway");
      await expect(gatewayCell).toBeVisible({
        timeout: LAUNCHED_CELL_TIMEOUT_MS,
      });
      expect(GATEWAY_ROLLUP_STATES).toContainEqual({
        detail: await gatewayCell.getAttribute("title"),
        label: (await gatewayCell.textContent())?.trim(),
      });

      // The reported ISS-5768 machine: session lanes drained, thousands of
      // component-inventory rows still on the device, one invocation part
      // abandoned. The cell must not round that up.
      const historySyncCell = statusCellValue(shell, "History Sync");
      await expect(historySyncCell).toHaveText("Syncing (2,985 left)", {
        timeout: LAUNCHED_CELL_TIMEOUT_MS,
      });
      const detail = await historySyncCell.getAttribute("title");
      expect(detail).toContain("2,985 items still to upload");
      expect(detail).toContain("1 item could not be uploaded");
      await page.evaluate((source) => {
        Function(source)();
      }, axe.source);
      const nativePanel = shell.getByRole("region", {
        name: DESKTOP_APP_HEADING,
        exact: true,
      });
      const axeResults = await nativePanel.evaluate(
        (panel, tags) =>
          window.axe.run(panel, {
            resultTypes: ["violations"],
            runOnly: { type: "tag", values: [...tags] },
          }),
        WCAG_AA_TAGS
      );
      expect(
        axeResults.violations.filter(
          (violation) => violation.impact === "critical"
        )
      ).toEqual([]);
      // The panel's body is a `React.lazy` chunk, so an unresolved specifier
      // blanks the renderer rather than failing any locator above with a cause.
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("reads Up to date on the same cell when every lane is drained", async () => {
    test.setTimeout(120_000);
    // The counterfactual for the case above: same launch, same cloud identity,
    // drained readiness. Without it that assertion would pass on a cell that
    // can no longer reach its success state at all.
    const { cleanup, pageErrors, shell } = await openDesktopAppPanel(
      drainedCloudReadReadiness(),
      "desktop-app-panel-history-sync-drained-"
    );
    try {
      const historySyncCell = statusCellValue(shell, "History Sync");
      await expect(historySyncCell).toHaveText("Up to date", {
        timeout: LAUNCHED_CELL_TIMEOUT_MS,
      });
      await expect(historySyncCell).toHaveAttribute(
        "title",
        "Your history is synced to your workspace"
      );
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

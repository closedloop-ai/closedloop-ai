/**
 * E2E visual QA for FEA-2329: Gateway Health lives in Settings > Labs, not in
 * the sidebar footer. The screenshot is written to Playwright's test output.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import axe from "axe-core";
import { WCAG_AA_TAGS } from "../../../../packages/app/test/a11y/axe.ts";
import {
  assertContrastPair,
  ContrastThreshold,
  resolveCompositedBackground,
} from "../../../../packages/app/test/a11y/contrast.ts";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";

const GATEWAY_HEALTH_STATUS_RE = /^(Connected|Needs Attention|Offline)$/;
const GATEWAY_SECURITY_DETAIL_RE =
  /^(No cloud API key is configured\.|Using a manually configured bearer key\.|Managed key is present but request signing is unavailable\.|Managed key with request signing is configured\.)$/;

test.describe("Settings Labs gateway health", () => {
  test("shows Gateway Health in Labs and omits the sidebar health row", async () => {
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-settings-labs-codex-home-")
    );
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-settings-labs-claude-home-")
    );
    let cleanupApp: (() => Promise<void>) | undefined;
    let cleanupError: unknown;

    try {
      const { cleanup, page, pageErrors } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataPrefix: "desktop-settings-labs-gateway-health-e2e-",
      });
      cleanupApp = cleanup;

      expect(codexHome).toContain(os.tmpdir());
      expect(claudeHome).toContain(os.tmpdir());
      expect(fs.existsSync(codexHome)).toBe(true);
      expect(fs.existsSync(claudeHome)).toBe(true);

      await gotoNav(page, "settings");
      await expect(page.locator("header").getByText("Settings")).toBeVisible();

      await page.getByRole("tab", { name: "Labs" }).click();

      const labsPanel = page.getByRole("tabpanel", { name: "Labs" });
      await expect(labsPanel.getByText("Gateway Health")).toBeVisible();
      await expect(labsPanel.getByText(GATEWAY_HEALTH_STATUS_RE)).toBeVisible();
      await expect(
        labsPanel.getByText(GATEWAY_SECURITY_DETAIL_RE)
      ).toBeVisible();
      await expectLocatorContrast(
        labsPanel.getByText("Gateway Health"),
        "Gateway Health heading"
      );
      await expectLocatorContrast(
        labsPanel.getByText(GATEWAY_HEALTH_STATUS_RE),
        "Gateway Health status"
      );
      await expectLocatorContrast(
        labsPanel.getByText(GATEWAY_SECURITY_DETAIL_RE),
        "Gateway security detail"
      );
      await page.evaluate((source) => {
        Function(source)();
      }, axe.source);
      const axeResults = await page.evaluate((tags) => {
        const panel = document.querySelector(
          '[role="tabpanel"][aria-labelledby]'
        );
        if (!panel) {
          throw new Error("Labs panel was not found for axe scan.");
        }
        return window.axe.run(panel, {
          resultTypes: ["violations"],
          runOnly: {
            type: "tag",
            values: [...tags],
          },
        });
      }, WCAG_AA_TAGS);
      expect(
        axeResults.violations.filter(
          (violation) => violation.impact === "critical"
        )
      ).toEqual([]);
      await expect(
        labsPanel.getByText("Agent Dashboard", { exact: true })
      ).toBeVisible();
      await expect(
        labsPanel.getByText("Verbose Logging", { exact: true })
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Closedloop Gateway" })
      ).toBeVisible();
      await expect(
        page.getByText("Gateway healthy", { exact: true })
      ).toHaveCount(0);
      await expect(
        page.getByText("Gateway unhealthy", { exact: true })
      ).toHaveCount(0);

      await page.screenshot({
        fullPage: true,
        path: test.info().outputPath("settings-labs-gateway-health.png"),
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

async function expectLocatorContrast(
  locator: Locator,
  label: string,
  {
    colorProperty = "color",
    threshold = ContrastThreshold.NormalText,
  }: {
    colorProperty?: "backgroundColor" | "color";
    threshold?: ContrastThreshold;
  } = {}
) {
  const colors = await locator.evaluate((element, property) => {
    const foreground = getComputedStyle(element)[property];
    let current: Element | null = element;
    const backgrounds: string[] = [];
    while (current) {
      const color = getComputedStyle(current).backgroundColor;
      if (color) {
        backgrounds.push(color);
      }
      current = current.parentElement;
    }
    return { backgrounds, foreground };
  }, colorProperty);
  assertContrastPair({
    background: resolveCompositedBackground(colors.backgrounds),
    foreground: colors.foreground,
    label,
    threshold,
  });
}

/**
 * E2E for ISS-4577: the global sandbox base directory (set once during
 * onboarding) is now viewable + editable in Settings > Security. This spec
 * launches the built Electron app, navigates to the Security tab, and drives the
 * PRIMARY flow of the new surface end to end: edit the field, click Save, then
 * relaunch the app against the SAME user-data dir and assert the edited value
 * persisted (the readback after reload). Without the updateSettings persistence
 * wiring this readback fails, so the test actually guards the save path (codex +
 * wongk review) rather than only asserting the field is editable.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";

test.describe("Settings sandbox directory (ISS-4577)", () => {
  test("edits, saves, and persists the sandbox directory across a relaunch", async () => {
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-settings-sandbox-codex-home-")
    );
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-settings-sandbox-claude-home-")
    );
    // A REAL, existing directory whose canonical realpath is a non-risky sandbox
    // root: a tmp dir realpaths under /private (macOS) which the persist-time
    // risky-root guard rejects, and a missing dir keeps Save disabled. A dot-dir
    // directly under home realpaths to itself and clears the /Users/<name> guard,
    // so it both enables Save and is what gets persisted (the canonicalized path).
    const sandboxDir = fs.mkdtempSync(
      path.join(os.homedir(), ".cl-iss4577-e2e-sandbox-")
    );
    const canonicalSandbox = fs.realpathSync.native(sandboxDir);
    // Persisted, keep-alive user-data dir so we can relaunch and read back.
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-settings-sandbox-path-e2e-")
    );

    let cleanupFirst: (() => Promise<void>) | undefined;
    let cleanupSecond: (() => Promise<void>) | undefined;
    let cleanupError: unknown;

    try {
      // --- Launch 1: edit + save ---
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataDir,
        keepUserDataDir: true,
      });
      cleanupFirst = first.cleanup;

      await gotoNav(first.page, "settings");
      await expect(
        first.page.locator("header").getByText("Settings")
      ).toBeVisible();
      await first.page.getByRole("tab", { name: "Security" }).click();

      const securityPanel = first.page.getByRole("tabpanel", {
        name: "Security",
      });
      await expect(
        securityPanel.getByRole("heading", { name: "Sandbox Directory" })
      ).toBeVisible();
      // The section heading names the field; the input carries an sr-only label
      // of the same name (wongk review, ISS-4577). Target the textbox by role so
      // the same-text heading is not matched.
      const sandboxInput = securityPanel.getByRole("textbox", {
        name: "Sandbox Directory",
      });
      await expect(sandboxInput).toBeVisible();

      // Edit to the real dir; Save enables once the debounced inspection settles
      // and confirms the directory exists / is not risky.
      await sandboxInput.fill(sandboxDir);
      const saveButton = securityPanel.getByRole("button", { name: "Save" });
      await expect(saveButton).toBeEnabled();
      await saveButton.click();
      // Save completes when the button goes back to disabled (isUnchanged flips
      // true once the persisted value matches the field).
      await expect(saveButton).toBeDisabled();

      expect(first.pageErrors).toEqual([]);
      await first.cleanup();
      cleanupFirst = undefined;

      // --- Launch 2: read back after reload ---
      const second = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataDir,
        keepUserDataDir: true,
      });
      cleanupSecond = second.cleanup;

      await gotoNav(second.page, "settings");
      await second.page.getByRole("tab", { name: "Security" }).click();
      const secondPanel = second.page.getByRole("tabpanel", {
        name: "Security",
      });
      const reloadedInput = secondPanel.getByRole("textbox", {
        name: "Sandbox Directory",
      });
      // The persisted value is the canonicalized real directory (ISS-4577), so
      // the field rehydrates from it after the relaunch.
      await expect(reloadedInput).toHaveValue(canonicalSandbox);

      expect(second.pageErrors).toEqual([]);
      await second.cleanup();
      cleanupSecond = undefined;
    } finally {
      for (const cleanup of [cleanupFirst, cleanupSecond]) {
        if (cleanup) {
          try {
            await cleanup();
          } catch (error) {
            cleanupError = error;
          }
        }
      }
      fs.rmSync(userDataDir, { force: true, recursive: true });
      fs.rmSync(sandboxDir, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
    }
    expect(fs.existsSync(codexHome)).toBe(false);
    expect(fs.existsSync(claudeHome)).toBe(false);
    expect(cleanupError).toBeUndefined();
  });
});

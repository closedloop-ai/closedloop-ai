/**
 * E2E test: Gateway profile lifecycle — create, switch, rename, delete.
 *
 * Launches the Desktop Electron app via the shared harness, navigates to the
 * Settings → Relay / Gateway panel, and exercises the GatewayProfilesCard UI
 * through a full profile lifecycle.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 *
 * The test uses the compiled main-process entry at dist/main/index.js and
 * interacts only through the rendered UI — no direct IPC calls.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktop-app";

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Navigate the renderer to the Settings panel via hash routing and wait for
 * the "Relay / Gateway" tab to be visible.
 */
async function openSettingsRelayTab(page: Page): Promise<void> {
  // The renderer uses hash-based routing: #tab=settings
  await page.evaluate(() => {
    window.location.hash = "tab=settings";
  });
  // Wait for the settings heading to appear
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  // The "Relay / Gateway" tab is the default active tab; click it explicitly
  // in case a previous test left a different tab selected.
  await page.getByRole("tab", { name: "Relay / Gateway" }).click();
  // Wait for the Gateway Profiles card to be rendered. The card heading is a
  // design-system CardTitle (a <div>, not a heading role), so match by text.
  await expect(
    page.getByText("Gateway Profiles", { exact: true })
  ).toBeVisible();
}

// ─── tests ──────────────────────────────────────────────────────────────────

test.describe("Gateway profile lifecycle", () => {
  test("create, switch, rename, and delete a profile", async () => {
    // Launch the Electron app via the shared harness. A per-test user-data
    // directory keeps saved profiles from leaking across runs or from a
    // developer's normal Desktop app state.
    const { page, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-profile-e2e-",
    });

    try {
      // ── STEP 1: Navigate to Settings → Relay / Gateway ──────────────────
      await openSettingsRelayTab(page);

      // ── STEP 2: Create a new profile ────────────────────────────────────
      // Click the "Save Profile" button to open the dialog.
      await page.getByRole("button", { name: "Save Profile" }).click();

      // The dialog heading confirms the dialog is open.
      await expect(
        page.getByRole("heading", {
          name: "Save Current Configuration as Profile",
        })
      ).toBeVisible();

      // Type a profile name into the input.
      const profileName = "E2E Test Profile";
      await page.getByPlaceholder("e.g. Production").fill(profileName);

      // Submit via the dialog's "Save Profile" button (the one inside DialogFooter).
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Save Profile" })
        .click();

      // The dialog should close and the profile row should appear.
      await expect(
        page.getByRole("heading", {
          name: "Save Current Configuration as Profile",
        })
      ).not.toBeVisible();

      // Scope row interactions to the profile-rows container (the `space-y-2`
      // list that holds the GatewayProfileRow). A per-test user-data dir starts
      // with no saved profiles, so after creation it holds exactly one row. A
      // freshly-saved profile is auto-selected, which renders its name (and an
      // Active badge, and a Save button) again in a sibling "Selected Profile"
      // section — scoping to the rows container avoids those collisions.
      const profilesCard = page
        .locator('[data-slot="card"]')
        .filter({ hasText: "Gateway Profiles" });
      const profileRow = profilesCard.locator("div.space-y-2").first();

      // The profile name should appear in the row.
      await expect(
        profileRow.getByText(profileName, { exact: true })
      ).toBeVisible();

      // ── STEP 3: Switch to the profile via "Apply" ────────────────────────
      // A freshly-saved profile may or may not be the active one. Apply only
      // when it is not already marked Active.
      const activeBadge = profileRow.getByText("Active", { exact: true });
      const isAlreadyActive = await activeBadge.isVisible().catch(() => false);
      if (!isAlreadyActive) {
        await profileRow.getByRole("button", { name: "Apply" }).click();
        await expect(activeBadge).toBeVisible({ timeout: 10_000 });
      }

      // ── STEP 4: Rename the profile via the pencil icon ───────────────────
      // The button has title="Rename profile" from the GatewayProfileRow.
      await profileRow.getByTitle("Rename profile").click();

      // An inline input appears with the current name pre-filled.
      const renameInput = profileRow.getByRole("textbox");
      await expect(renameInput).toBeVisible();
      await expect(renameInput).toHaveValue(profileName);

      // Clear and type a new name.
      const renamedName = "E2E Renamed Profile";
      await renameInput.clear();
      await renameInput.fill(renamedName);

      // Click the "Save" button in the rename inline form.
      await profileRow
        .getByRole("button", { name: "Save", exact: true })
        .click();

      // The renamed profile name should now be visible; the old name gone.
      await expect(
        profileRow.getByText(renamedName, { exact: true })
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        profileRow.getByText(profileName, { exact: true })
      ).toHaveCount(0);

      // ── STEP 5: Delete the profile via the trash icon ────────────────────
      await profileRow.getByTitle("Delete profile").click();

      // A confirmation prompt should appear.
      await expect(
        page.getByText(`Delete "${renamedName}"? This cannot be undone.`)
      ).toBeVisible();

      // Confirm deletion.
      await profileRow
        .getByRole("button", { name: "Delete", exact: true })
        .click();

      // The profile should be removed from the list.
      await expect(
        profilesCard.getByText(renamedName, { exact: true })
      ).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await cleanup();
    }
  });
});

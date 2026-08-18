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

type Rgb = { r: number; g: number; b: number };

/** Parse a resolved `rgb(r, g, b)` / `rgb(r g b)` / `rgba(...)` string. */
function parseRgb(value: string): Rgb {
  const match = value.match(/(\d+(?:\.\d+)?)/g);
  if (!match || match.length < 3) {
    throw new Error(`Unparseable resolved color: "${value}"`);
  }
  const [r, g, b] = match.map(Number);
  return { r, g, b };
}

/**
 * Whether two sRGB colors are the same to the nearest 8-bit channel. Computed
 * values reach us as sRGB bytes (canvas-resolved), so exact-string equality is
 * unreliable across color-space spellings — compare channels instead.
 */
function rgbEquals(a: Rgb, b: Rgb): boolean {
  return (
    Math.round(a.r) === Math.round(b.r) &&
    Math.round(a.g) === Math.round(b.g) &&
    Math.round(a.b) === Math.round(b.b)
  );
}

/** Relative luminance (WCAG 2.x) of an sRGB color. */
function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.039_28 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two sRGB colors. */
function contrastRatio(foreground: Rgb, background: Rgb): number {
  const lFg = relativeLuminance(foreground);
  const lBg = relativeLuminance(background);
  const lighter = Math.max(lFg, lBg);
  const darker = Math.min(lFg, lBg);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Pin the FEA-4047 fix: with the light-mode dialog open, `<body>` must resolve
 * to the design-system `--foreground` token, and the dialog title must read with
 * real contrast — never an unlayered override from the splash `<style>` block in
 * `renderer/design-system/index.html`.
 *
 * Asserted against the LIVE token rather than a pinned splash color. It used to
 * compare against the splash's literal `#e5e7eb`, which only worked while the
 * splash carried a distinctive dark palette; ISS-5346 moved the splash onto the
 * design-system light token VALUES (so the splash stops flashing dark in front
 * of a light-default app), which would have made a pinned-color check either
 * vacuous or self-contradictory. Reading `--foreground` off the document element
 * is the palette-independent form of the same invariant, and it stays true
 * whatever the splash is painted in.
 */
async function assertSplashPaletteDoesNotLeak(page: Page): Promise<void> {
  // Resolve the dialog title's color, the nearest opaque surface behind it,
  // <body>'s color, and the live `--foreground` token — all normalized to sRGB
  // `rgb(r, g, b)` strings. The
  // design-system tokens are authored in oklch, so getComputedStyle() returns
  // `oklch(...)` strings on modern Chromium/Electron; painting each color to a
  // canvas and reading the pixel back is the reliable way to normalize any color
  // space (oklch/hex/named/rgb) to sRGB bytes for WCAG luminance math.
  const { bodyColor, textColor, surfaceColor, foregroundToken } = await page
    .getByRole("heading", {
      name: "Save Current Configuration as Profile",
    })
    .evaluate((el) => {
      const toRgb = (color: string): string => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          return color;
        }
        ctx.fillStyle = "#000";
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return `rgb(${r}, ${g}, ${b})`;
      };
      const resolveSurface = (node: Element): string => {
        let current: Element | null = node;
        while (current) {
          const bg = getComputedStyle(current).backgroundColor;
          if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
            return toRgb(bg);
          }
          current = current.parentElement;
        }
        return toRgb(getComputedStyle(document.body).backgroundColor);
      };
      return {
        bodyColor: toRgb(getComputedStyle(document.body).color),
        textColor: toRgb(getComputedStyle(el).color),
        surfaceColor: resolveSurface(el),
        foregroundToken: toRgb(
          getComputedStyle(document.documentElement)
            .getPropertyValue("--foreground")
            .trim()
        ),
      };
    });

  // The body must render the theme foreground token itself. An unlayered
  // `body { color }` from the splash <style> beats the design-system's layered
  // `@layer base` rule, so any value other than the token means the leak is back.
  expect(rgbEquals(parseRgb(bodyColor), parseRgb(foregroundToken))).toBe(true);
  // 4.5:1 is the WCAG AA floor for normal-weight text. A leaked near-white
  // dialog title against the light dialog surface falls well under this.
  expect(
    contrastRatio(parseRgb(textColor), parseRgb(surfaceColor))
  ).toBeGreaterThanOrEqual(4.5);
}

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

      // Regression pin (FEA-4047): the splash palette must not leak onto <body>
      // and wash out this light-mode dialog's title.
      await assertSplashPaletteDoesNotLeak(page);

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

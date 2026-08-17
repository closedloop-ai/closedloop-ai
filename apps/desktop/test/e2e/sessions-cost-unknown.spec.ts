/**
 * ISS-4481 (Electron twin): the selectable "Unknown" (missing-cost) Cost filter
 * option on the shared Sessions list, driven seed-to-render through the real
 * desktop SQLite store and the renderer's `SessionsView` -> `SessionsToolbar` /
 * `SyncedSessionsTable`. The web twin is `e2e/sessions-cost-unknown.spec.ts`;
 * both mount the same shared surface (`packages/app`), so wongk's cross-surface
 * rule requires a real-surface regression on each adapter.
 *
 * The corpus: one PRICED (known-cost) worked session that renders a `$` figure,
 * and one UNKNOWN-cost session (non-subscription, $0, no work) that renders "—".
 * Selecting Cost -> Unknown must narrow to the "—" row and drop the priced row.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const PRICED_NAME = "iss-4481 priced session";
const UNKNOWN_NAME = "iss-4481 unknown-cost session";
const UNKNOWN_SESSION_ID = "iss-4481-unknown";

const SEEDED: SessionListSeed[] = [
  // A worked, priced session → renders a $ figure → EXCLUDED from Cost = Unknown.
  { sessionId: "iss-4481-priced", name: PRICED_NAME, estimatedCost: 4.25 },
  // A non-subscription, $0, no-work session → renders "—" → the Unknown cohort.
  { sessionId: UNKNOWN_SESSION_ID, name: UNKNOWN_NAME, idle: true },
];

test.describe("Sessions Cost = Unknown filter (ISS-4481)", () => {
  test("narrows to the — (missing-cost) rows and drops the priced row", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-cost-unknown-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts, inflating the
    // seeded corpus this spec pins.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-cost-unknown-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-cost-unknown-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      await seedSessionsList(userDataDir, SEEDED);

      // Launch 2 — drive the real Filter menu.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "sessions");

        // Widen to "All time" so the seeded corpus is in range regardless of the
        // run clock. `:visible` scopes to the mounted Sessions toolbar.
        await page.locator('[aria-label="All time"]:visible').click();

        // Prove the full corpus rendered first (both rows) — a negative
        // assertion below passes vacuously on a never-rendered page.
        await expect(page.getByRole("link", { name: PRICED_NAME })).toBeVisible(
          {
            timeout: 30_000,
          }
        );
        await expect(
          page.getByRole("link", { name: UNKNOWN_NAME })
        ).toBeVisible({ timeout: 30_000 });

        // Open Filter -> Cost -> Unknown.
        await page
          .getByRole("button", { name: "Filter" })
          .filter({ visible: true })
          .click();
        // FilterPopover -> FilterRow renders each option as a plain Radix
        // `DropdownMenuItem` with a decorative (pointer-events-none) Checkbox
        // inside — it is NOT a `DropdownMenuCheckboxItem` — so the Unknown option
        // carries role `menuitem`, not `menuitemcheckbox` or `menuitemradio`.
        await page.getByRole("menuitem", { name: "Cost" }).click();
        await page.getByRole("menuitem", { name: "Unknown" }).click();
        // Dismiss the menu so the list is interactable for assertions.
        await page.keyboard.press("Escape");

        // The Unknown cohort: the "—" row stays, the priced row is gone.
        await expect(
          page.getByRole("link", { name: UNKNOWN_NAME })
        ).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole("link", { name: PRICED_NAME })).toHaveCount(
          0
        );

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });
});

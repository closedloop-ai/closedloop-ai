/**
 * ISS-10528 / PRD-723: this local SQLite fixture supplies neither favorites nor
 * eligible cloud-artifact bulk actions, so its rows must not arm selection-only
 * range drag, while the shared pointer contract must reach the Desktop host.
 * The renderer suite covers the capability fold with mocked data/flag ports;
 * this case reaches the actual profile assignment, SQLite, IPC and mounted host.
 * Shared retired keyboard-marker assertions remain in the renderer suite.
 */
import { expect, test } from "@playwright/test";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "../../../../packages/app/shared/lib/feature-flags.ts";
import { expectDesktopRowPointerRefusal } from "./helpers/grid-pointer-contract";
import {
  mapInactiveLinuxCiWindow,
  selectInactiveLinuxCiMapping,
} from "./helpers/inactive-linux-ci-window";
import type { SessionListSeed } from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
} from "./helpers/seeded-sessions-list";
import { withSeededSessionsV2List } from "./helpers/seeded-sessions-v2-list";

const SEEDED_ROW_COUNT = 3;
const SEEDED_ROW_NAME_PATTERN = /^ISS-10528 desktop selection row \d$/;
const SELECTABLE_ROW_SELECTOR = "[data-grid-selectable-row]";

function rowName(index: number): string {
  return `ISS-10528 desktop selection row ${index + 1}`;
}

const SEEDED_SESSIONS: SessionListSeed[] = Array.from(
  { length: SEEDED_ROW_COUNT },
  (_, index) => {
    const at = new Date(Date.now() - (index + 1) * 60_000).toISOString();
    return {
      at,
      lastActivityAt: at,
      name: rowName(index),
      sessionId: `iss-10528-desktop-selection-${index + 1}`,
      status: "inactive",
    };
  }
);

for (const adoptionEnabled of [false, true]) {
  test(`Desktop Sessions keeps the adoption-${adoptionEnabled ? "on" : "off"} pointer path without arming row range drag`, async () => {
    test.setTimeout(300_000);
    const dirs = makeSeededSessionsDirs(
      `desktop-no-selection-model-adoption-${adoptionEnabled ? "on" : "off"}`
    );
    try {
      await withSeededSessionsV2List(
        dirs,
        {
          featureFlags: {
            [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]: adoptionEnabled,
            "grid-table-v2": true,
          },
          readyRowName: rowName(0),
          sessions: SEEDED_SESSIONS,
        },
        async (page, panel, app) => {
          // The helper has already proved v2 mounted. All seeded rows must also
          // reach the active Sessions panel before its absence can be meaningful.
          await expect(
            panel.getByRole("link", { name: SEEDED_ROW_NAME_PATTERN })
          ).toHaveCount(SEEDED_ROW_COUNT);
          await expect(
            panel.locator(SELECTABLE_ROW_SELECTOR),
            "the Desktop host has no selection model to resolve a range into"
          ).toHaveCount(0);
          await expect(
            panel.locator('[data-grid-interaction-contract="pointer-hover"]')
          ).toHaveCount(adoptionEnabled ? 1 : 0);
          if (adoptionEnabled) {
            // ISS-12901: each native link drag needs the renderer to process its
            // pointer moves before Playwright's drag interception checks for a
            // dragstart; the unmapped Linux CI Xvfb window delivers about one
            // frame per second, so a modified drag could miss it there.
            await mapInactiveLinuxCiWindow(
              app,
              page,
              selectInactiveLinuxCiMapping(
                { platform: process.platform, env: process.env },
                true
              )
            );
            const row = panel.locator(
              `[data-grid-row-id="${SEEDED_SESSIONS[0]!.sessionId}"]`
            );
            const link = row.getByRole("link", { name: rowName(0) });
            await expect
              .poll(() =>
                row.evaluate((element) => getComputedStyle(element).cursor)
              )
              .toBe("default");
            await expect
              .poll(() =>
                link.evaluate((element) => getComputedStyle(element).cursor)
              )
              .toBe("pointer");
            const destination = panel
              .locator(`[data-grid-row-id="${SEEDED_SESSIONS[1]!.sessionId}"]`)
              .locator("[data-grid-cell]")
              .first();
            await expectDesktopRowPointerRefusal({
              destination,
              link,
              page,
              row,
              surface: panel,
            });

            // The local host exposes grouping, but no groupDrop move controller.
            await panel
              .getByRole("button", { exact: true, name: "Group" })
              .click();
            await page
              .getByRole("combobox", { name: "Primary grouping field" })
              .click();
            await page
              .getByRole("option", { exact: true, name: "Status" })
              .click();
            await page.keyboard.press("Escape");
            const groupToggle = panel
              .locator('[role="rowgroup"] > [role="row"]')
              .getByRole("button")
              .first();
            await expect(groupToggle).toHaveAttribute("aria-expanded", "true");
            await groupToggle.click();
            await expect(groupToggle).toHaveAttribute("aria-expanded", "false");
            await expect(
              panel.getByRole("link", { name: SEEDED_ROW_NAME_PATTERN })
            ).toHaveCount(0);
            await groupToggle.click();
            await expect(groupToggle).toHaveAttribute("aria-expanded", "true");
            await expect(link).toBeVisible();
            const href = await link.getAttribute("href");
            if (!href) {
              throw new Error(
                "The production Session link has no navigation href"
              );
            }
            const destinationUrl = new URL(href, page.url()).href;
            await link.click();
            await expect(page).toHaveURL(destinationUrl);
          }
        }
      );
    } finally {
      await cleanupSeededSessionsDirs(dirs);
    }
  });
}

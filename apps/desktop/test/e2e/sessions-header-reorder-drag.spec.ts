/**
 * ISS-5812: a REAL browser-native header drag reorders the Sessions columns
 * (Electron renderer).
 *
 * wongk review, desktop half. The web twin is
 * `e2e/sessions-header-reorder-drag.spec.ts` and its docstring carries the full
 * rationale: ISS-5812 moved the reorder pointer target off the 24px grip and
 * onto the header cell, and the only coverage that move had was a SYNTHETIC
 * `dragstart` in jsdom — which cannot fail for the reason the change can
 * actually break, namely which element the HTML drag model picks as the drag
 * SOURCE when the press lands on one of the header's nested controls.
 *
 * Why this is not redundant with the web spec. `GridTable` is shared through
 * `@repo/app`, but nothing else about the two runs is: this is a different
 * Chromium (Electron's bundled one, not the runner's), a different flag
 * mechanism (a seeded Labs config rather than a routed PostHog payload), and a
 * different saved-view store (the desktop `sessions:saved-view:sessions:desktop`
 * key rather than the web surface's). A shared-UI change passing on one surface
 * and failing on the other is the routine outcome here, not the exotic one, so
 * neither run is allowed to stand in for the other.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

/**
 * Spelled as a literal rather than imported from
 * `@repo/api/src/types/grid-table-v2-flag`: that module's extension-less imports
 * do not resolve under Playwright's ESM loader, and a spec-level import failure
 * aborts the WHOLE desktop-e2e suite at load time (the same constraint
 * `sessions-column-fold.spec.ts` documents). Drift is caught first by the
 * `test:node` pins in `apps/desktop/test/feature-flags.test.ts`.
 */
const GRID_TABLE_V2_FLAG_KEY = "grid-table-v2";

// Wide enough that a second reorderable data column is rendered to drag onto.
const DESKTOP_VIEWPORT = { height: 900, width: 1600 };

const SEEDED_SESSIONS: SessionListSeed[] = [
  { name: "ISS-5812 header drag 1", sessionId: "iss-5812-header-drag-1" },
];

/**
 * Only the REORDERABLE header cells. `name` and `actions` also carry
 * `data-column-id` but are pinned out of `columnOrder`, so a plain sweep would
 * put an immovable column at index 0 and make the drag a no-op that still
 * "passed". Addressed by `data-column-id` rather than accessible name because a
 * reorderable header folds the grip's own label into its accessible name.
 *
 * `:visible` matters on desktop specifically: keep-alive views stay
 * mounted-but-hidden and render a second copy of the same header row.
 */
const REORDERABLE_HEADER =
  '[role="columnheader"][data-column-id]:has(button[aria-label^="Reorder"]):visible';

async function headerColumnIds(page: Page): Promise<string[]> {
  return await page
    .locator(REORDERABLE_HEADER)
    .evaluateAll((cells) =>
      cells.map((cell) => (cell as HTMLElement).dataset.columnId ?? "")
    );
}

function headerFor(page: Page, columnId: string) {
  return page
    .locator(`[role="columnheader"][data-column-id="${columnId}"]`)
    .locator("visible=true");
}

test.describe("Sessions header reorder drag (ISS-5812)", () => {
  test("a real drag begun on the header's sort button reorders the columns", async () => {
    test.setTimeout(180_000);

    // Empty CLAUDE_HOME/CODEX_HOME so the boot collectors ingest nothing and the
    // only rows are the seeded ones.
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-header-drag-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-header-drag-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-header-drag-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, then close so the seed
      // writes without cross-process WAL contention.
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

      await seedSessionsList(userDataDir, SEEDED_SESSIONS);
      // The reorder grip and the v2 resize strip only render with v2 on, and the
      // seam this spec presses into exists only when both are present.
      seedDesktopFeatureFlags(userDataDir, {
        [GRID_TABLE_V2_FLAG_KEY]: true,
      });

      const { page, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await page.setViewportSize(DESKTOP_VIEWPORT);
        await gotoNav(page, "sessions");
        // Widen the window filter so the seeded rows are in range independent of
        // the run clock.
        await page.locator('[aria-label="All time"]:visible').click();
        await expect(
          page.getByRole("link", { name: SEEDED_SESSIONS[0].name })
        ).toBeVisible({ timeout: 30_000 });

        const before = await headerColumnIds(page);
        // The gesture needs two distinct reorderable columns to be meaningful.
        expect(before.length).toBeGreaterThan(1);
        const [first_, second] = before;

        // The drag SOURCE is a nested control, not bare cell padding. The HTML
        // drag model walks UP from whatever was pressed to the nearest
        // `draggable` ancestor, and this is the only gesture that exercises that
        // walk — a drag begun on empty padding passes with every nested control
        // swallowing the press.
        //
        // Excluded: the reorder grip (`pointer-events-none`, so a press never
        // lands on it) and the resize strip (deliberately exempted from the drag
        // by `handleResizePointerDown`). The first of what remains is the sort
        // button spanning the label — the realistic grab point.
        const nestedControls = headerFor(page, second).locator(
          'button:not([aria-label^="Reorder"]):not([aria-label^="Resize"])'
        );
        // Guard the guard: with no nested control the press would land on
        // padding and stop testing the ancestor walk at all.
        expect(await nestedControls.count()).toBeGreaterThan(0);

        await nestedControls.first().dragTo(headerFor(page, first_));

        // `handleColumnDrop` moves the dragged column BEFORE its drop target, so
        // the two swap and everything after them is untouched. Asserting the
        // WHOLE order catches a drop that reordered more than it was asked to.
        await expect
          .poll(() => headerColumnIds(page), { timeout: 15_000 })
          .toEqual([second, first_, ...before.slice(2)]);
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

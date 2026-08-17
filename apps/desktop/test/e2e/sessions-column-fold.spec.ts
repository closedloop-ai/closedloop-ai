/**
 * E2E regression: the Sessions grid never renders a column half-cut at rest
 * (ISS-4889).
 *
 * The default column set is ~2,156px wide against the ~1,108px content area the
 * 1380px window this spec pins leaves after the 256px sidebar, so the table
 * overflows and the
 * viewport's right edge — the fold — used to land in the MIDDLE of a track: a
 * chip clipped to half a word, and before ISS-4788 a currency figure clipped
 * mid-glyph (`$772.3`). Reordering columns only chose which one was cut.
 *
 * The renderer unit suite pins the emitted grid template, but it has to STUB the
 * measured container width — the one input the fix depends on. This drives the
 * real Electron window, reads the browser's own USED `grid-template-columns`, and
 * measures the fold against the real scroll container, so the layout arithmetic
 * is verified against an actual layout engine.
 *
 * The spec fails on the unfitted layout: at ~1108px the boundaries are
 * 300/480/612/712/892/1072/1220/…, and the fold falls inside the PR track.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
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

// A DELIBERATELY NARROW window, not the launch default — do not swap this for
// `DEFAULT_WINDOW_WIDTH`.
//
// This spec is about the FOLD, not about the default: it needs a content area
// the ~2,156px column set clearly overflows, so the fold has somewhere to land
// wrong. 1380 is the width ISS-4889 was reported at, and pinning it keeps the
// boundary arithmetic in the docstring above exact whatever display the runner
// has — and whatever the default is widened to next. (The default is 1400 since
// the window was widened; the table still overflows there, but this spec's
// measurements were taken at 1380 and there is no reason to re-derive them.)
const DESKTOP_VIEWPORT = { height: 900, width: 1380 };

// A grid track lands a hair either side of an integer once flex/rounding is
// applied, and the fitted lead is rounded to a whole pixel — so the fold may sit
// a fraction of a pixel off a boundary. Well below a glyph, let alone a column.
const SUB_PIXEL_TOLERANCE_PX = 1.5;

/**
 * The desktop Labs keys gating this pass. Spelled as literals rather than
 * imported from `../../src/shared/feature-flags`: that module's extension-less
 * `@repo/api/src/types/...` imports do not resolve under Playwright's ESM
 * loader, and a spec-level import failure aborts the WHOLE desktop-e2e suite at
 * load time (see the same note in `session-transcript-switcher.spec.ts`). Drift
 * is caught first by the `test:node` pins in `apps/desktop/test/feature-flags.test.ts`.
 */
const FOLD_LEGIBILITY_FLAG_KEY = "sessions-grid-fold-legibility";

// The legacy un-namespaced saved-view key for the desktop Sessions surface. The
// restore reads the per-user key first and falls back to this one, so seeding
// here works whether or not the profile is signed in.
const SAVED_VIEW_STORAGE_KEY = "sessions:saved-view:sessions:desktop";
// A real pre-ISS-4788 arrangement: Cost 6th, past the fold.
const UNMIGRATED_COLUMN_ORDER = [
  "owner",
  "status",
  "repo",
  "branch",
  "pr",
  "cost",
  "started",
];

const SEEDED_SESSIONS: SessionListSeed[] = Array.from(
  { length: 3 },
  (_value, index) => ({
    sessionId: `iss-4889-column-fold-${index + 1}`,
    name: `ISS-4889 column fold ${index + 1}`,
  })
);

type FoldGeometry = {
  /** Right edge of every rendered track, px from the table's left edge. */
  boundariesPx: number[];
  /** Distance from the table's left edge to where the scroll container clips. */
  foldPx: number;
  /** Whether the table is actually wider than its scroll container. */
  overflows: boolean;
  /** The header row's USED `grid-template-columns`. */
  headerTemplate: string;
  /**
   * A BODY row's USED `grid-template-columns`, or `null` if no data row was
   * found. The regression is clipped data cells, so the header agreeing with
   * itself proves nothing — a body row drifting back to the declared template
   * while the header stays fitted is exactly the failure this catches.
   */
  bodyTemplate: string | null;
};

test.describe("Sessions column fold (ISS-4889)", () => {
  test("no column is rendered partially visible at the default window width", async () => {
    test.setTimeout(180_000);

    // Empty CLAUDE_HOME/CODEX_HOME so the boot collectors ingest nothing and the
    // only rows are the seeded ones (mirrors sessions-list-dbseed.spec.ts).
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-column-fold-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-column-fold-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-column-fold-udd-")
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

      // Launch 2 — the real Sessions IPC source reads the seeded corpus at boot.
      const { page, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await page.setViewportSize(DESKTOP_VIEWPORT);
        await gotoNav(page, "sessions");
        // Widen the window filter so the rows are in range independent of the
        // run clock. `:visible` scopes to the Sessions toolbar (keep-alive views
        // stay mounted-but-hidden and render the same control).
        await page.locator('[aria-label="All time"]:visible').click();
        await expect(
          page.getByRole("link", { name: SEEDED_SESSIONS[0].name })
        ).toBeVisible({ timeout: 30_000 });

        const geometry = await readFoldGeometry(page);

        // Guard against a vacuous pass: if the table were not overflowing there
        // would be no fold to land wrong, and this spec would prove nothing.
        expect(geometry.overflows).toBe(true);

        // The defect is clipped DATA cells, so the body has to be pinned too: a
        // body row rendering the declared template while the header renders the
        // fitted one would still cut a data cell in half, and every boundary
        // assertion below — which reads the header — would pass through it.
        expect(geometry.bodyTemplate).not.toBeNull();
        expect(geometry.bodyTemplate).toBe(geometry.headerTemplate);

        // The fold lands ON a column's right edge — no track starts before it
        // and ends after it.
        const nearestBoundaryPx = geometry.boundariesPx.reduce(
          (nearest, boundary) =>
            Math.abs(boundary - geometry.foldPx) <
            Math.abs(nearest - geometry.foldPx)
              ? boundary
              : nearest,
          Number.POSITIVE_INFINITY
        );
        expect(
          Math.abs(nearestBoundaryPx - geometry.foldPx)
        ).toBeLessThanOrEqual(SUB_PIXEL_TOLERANCE_PX);

        // ISS-5315's Group by, driven through the launched Electron window
        // (#4480, wongk). This is the assertion that would have caught the
        // divergence this PR shipped with: the grouped column's removal lived
        // only in the web page, so DESKTOP banded the rows and then repeated
        // the banded value in every row beneath the band. Run at the end of
        // this test rather than in a third launch, which costs another ~180s.
        //
        // The web twin is `e2e/sessions-column-fold.spec.ts`; it pins the band
        // LABEL too, because its rows have a seeded status.
        const statusHeader = page
          .getByRole("columnheader", { name: "Status" })
          .locator("visible=true");
        // Not vacuous: Status IS on screen before the grouping is applied.
        await expect(statusHeader.first()).toBeVisible();

        // `TableViewMenu`'s trigger is a plain `<Button>` whose accessible name
        // comes from its VISIBLE TEXT — it carries no `aria-label`, so the
        // attribute selector this originally used matched nothing and only
        // surfaced as a 30s click timeout. Same locator the web twin uses,
        // `visible=true`-scoped because desktop keep-alive views stay
        // mounted-but-hidden and render the same control.
        await page
          .getByRole("button", { name: "View" })
          .locator("visible=true")
          .first()
          .click();
        await page.getByRole("radio", { name: "Status" }).click();
        await page.keyboard.press("Escape");

        // A real disclosure header appears…
        await expect(
          page.getByRole("button", { expanded: true }).first()
        ).toBeVisible({ timeout: 15_000 });
        // …and the column it bands on is no longer printed in every row.
        await expect(statusHeader).toHaveCount(0);
        await expect(
          page.getByRole("link", { name: SEEDED_SESSIONS[0].name })
        ).toBeVisible();
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
    }
  });
});

/**
 * ISS-4890 + ISS-4906 + ISS-4901 + ISS-4887 with the Labs toggles ON, at the
 * DESKTOP host (wongk cid 3700596175, codex cid 3700572381). The web twin is
 * `e2e/sessions-column-fold.spec.ts`.
 *
 * The renderer unit suite stubs the measured container width and the label
 * heights — the two inputs this pass derives from — so only the launched Electron
 * window proves the four flag-on paths against a real layout engine: the saved
 * view is migrated on restore, the fold survives a resize, the scroll cue is on
 * the scroll region, and the summary strip shares one derived label reservation.
 * The renderer's pane is narrower than the web content area, so more of the
 * table lives past the fold here than anywhere else.
 */
test.describe("Sessions grid fold legibility, gates ON (ISS-4890/4906/4901/4887)", () => {
  test("migrates the saved view, holds the fold through a resize, shows the scroll cue, and aligns the strip", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-fold-gated-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-fold-gated-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-fold-gated-udd-")
    );
    const seedGates = (dir: string) =>
      seedDesktopFeatureFlags(dir, {
        // ISS-5062: the summary-strip label reservation used to be seeded here
        // too. Its flag reached 100% rollout and was removed, so the assertion
        // below now covers the unconditional behavior.
        [FOLD_LEGIBILITY_FLAG_KEY]: true,
      });

    try {
      // Launch 1 — create + migrate the SQLite schema, then close so the seed
      // writes without cross-process WAL contention (mirrors the spec above).
      const first = await launchDesktopApp({
        beforeLaunch: seedGates,
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

      const { app, page, cleanup } = await launchDesktopApp({
        beforeLaunch: seedGates,
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await page.setViewportSize(DESKTOP_VIEWPORT);
        // Write the unmigrated saved view, then reload so the Sessions view
        // restores from it on a fresh mount rather than mid-life.
        await page.evaluate(
          ({ storageKey, view }) => {
            globalThis.localStorage.setItem(storageKey, JSON.stringify(view));
          },
          {
            storageKey: SAVED_VIEW_STORAGE_KEY,
            view: {
              columnOrder: UNMIGRATED_COLUMN_ORDER,
              dateRange: "30d",
              hiddenColumns: [],
              sortDir: "desc",
              sortKey: null,
            },
          }
        );
        await Promise.all([
          page.waitForEvent("framenavigated"),
          app.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0]?.webContents.reload();
          }),
        ]);
        await page.waitForLoadState("domcontentloaded");

        await gotoNav(page, "sessions");
        await page.locator('[aria-label="All time"]:visible').click();
        await expect(
          page.getByRole("link", { name: SEEDED_SESSIONS[0].name })
        ).toBeVisible({ timeout: 30_000 });

        // ISS-6065: the fixture this test ALREADY seeds is the legacy one —
        // `started` sits in UNMIGRATED_COLUMN_ORDER with an empty
        // `hiddenColumns` — so the hidden-columns repair is provable here for
        // the cost of three assertions rather than another ~180s launch. It has
        // to be provable HERE: `usePersistedTableViewState` is shared through
        // `@repo/app` and mounted by both surfaces, and the web twin
        // (`e2e/sessions-column-fold.spec.ts`) asserted only the browser, so
        // this lane passed on `main` unchanged (#5037, wongk). The migration
        // itself is ungated — it runs in BOTH parsers — so the flags this
        // describe seeds neither enable nor suppress it.
        //
        // `projects` / `issues` are in the same v2 payload but sit behind
        // `grid-table-v2`, which is not seeded here, so they have no rendered
        // state to assert; the unit guard covers them.
        await expect(columnHeaderById(page, "started")).toHaveCount(0);
        // The v1 half of the same repair, on the same fixture.
        await expect(columnHeaderById(page, "pr")).toHaveCount(0);
        // The control: `repo` is seeded in the same order and is NOT
        // default-hidden, so it still renders. Without it a table that failed to
        // render any header would satisfy both absence assertions vacuously.
        await expect(
          columnHeaderById(page, "repo").locator("visible=true").first()
        ).toBeVisible();

        // ISS-4901: the cue for the columns past the fold, on the region that
        // actually scrolls.
        await expect(
          page.locator(".overflow-auto.scrollbar-overlay").first()
        ).toBeVisible();

        // ISS-4890: the seeded order put Cost 6th, past the fold. After the
        // migration its whole track sits within the fold — a figure you have to
        // scroll to is the defect, not a layout preference.
        const migrated = await readFoldGeometry(page);
        expect(migrated.overflows).toBe(true);
        expect(await columnRightEdgePx(page, "Cost")).toBeLessThanOrEqual(
          migrated.foldPx + SUB_PIXEL_TOLERANCE_PX
        );

        // ISS-4906: a width change re-fits onto a boundary; it must not strand
        // the previous fit against the old width.
        await page.setViewportSize({
          height: DESKTOP_VIEWPORT.height,
          width: DESKTOP_VIEWPORT.width - 160,
        });
        await expect
          .poll(
            async () =>
              distanceToNearestBoundaryPx(await readFoldGeometry(page)),
            { timeout: 30_000 }
          )
          .toBeLessThanOrEqual(SUB_PIXEL_TOLERANCE_PX);

        // ISS-4887: one derived reservation for the whole strip, so the values
        // sit on a shared baseline instead of a guessed line count.
        const labelHeights = await readSummaryLabelHeightsPx(page);
        expect(labelHeights.length).toBeGreaterThan(1);
        expect(new Set(labelHeights).size).toBe(1);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
    }
  });
});

/** Distance (px) from the fold to the nearest rendered column boundary. */
function distanceToNearestBoundaryPx(geometry: FoldGeometry): number {
  const nearestPx = geometry.boundariesPx.reduce(
    (nearest, boundary) =>
      Math.abs(boundary - geometry.foldPx) < Math.abs(nearest - geometry.foldPx)
        ? boundary
        : nearest,
    Number.POSITIVE_INFINITY
  );
  return Math.abs(nearestPx - geometry.foldPx);
}

/** Right edge of a named column header, px from the table row's left edge. */
async function columnRightEdgePx(page: Page, name: string): Promise<number> {
  const header = page
    .getByRole("columnheader", { name })
    .locator("visible=true")
    .first();
  return await header.evaluate((cell) => {
    const row = cell.closest('[role="row"]');
    if (!row) {
      return Number.POSITIVE_INFINITY;
    }
    return (
      cell.getBoundingClientRect().right - row.getBoundingClientRect().left
    );
  });
}

/** Rendered height of every summary-card label region, rounded to whole px. */
async function readSummaryLabelHeightsPx(page: Page): Promise<number[]> {
  const labels = page.locator('[data-slot="card-description"]:visible');
  await expect(labels.first()).toBeVisible({ timeout: 30_000 });
  return await labels.evaluateAll((regions) =>
    regions.map((region) => Math.round(region.getBoundingClientRect().height))
  );
}

/**
 * Read the rendered column boundaries and the fold position from the live page.
 * Boundaries come from the browser's USED `grid-template-columns` (already
 * resolved to px), and the fold from the nearest horizontally-scrolling ancestor
 * — so this measures what the user actually sees, not what the caller declared.
 */
async function readFoldGeometry(page: Page): Promise<FoldGeometry> {
  // `visible=true` scopes to the mounted Sessions table: keep-alive views stay
  // mounted-but-hidden and render a column header of their own.
  const headerRow = page
    .getByRole("columnheader", { name: "Session" })
    .locator("visible=true")
    .first()
    .locator("xpath=ancestor::*[@role='row'][1]");
  await expect(headerRow).toBeVisible({ timeout: 30_000 });

  // The body of `evaluate` is serialized into the page, so it cannot close over
  // an import — `parseGridTrackMinWidthsPx` is unavailable here. It is also not
  // needed: `getComputedStyle` returns USED track sizes, already plain px with
  // no `minmax()` left to unpack, so this is a different (and simpler) parse
  // than the declared-template one, not a second copy of it.
  return await headerRow.evaluate((row): FoldGeometry => {
    const headerTemplate = getComputedStyle(row).gridTemplateColumns;
    const boundariesPx: number[] = [];
    let cumulative = 0;
    for (const track of headerTemplate.split(" ")) {
      const widthPx = Number.parseFloat(track);
      if (Number.isFinite(widthPx)) {
        cumulative += widthPx;
        boundariesPx.push(cumulative);
      }
    }

    // A BODY row (one carrying `role="cell"`), found by widening the search from
    // the header outwards so this does not depend on how the header and body are
    // nested. Its used template must match the header's, or a data cell is being
    // laid out on different tracks than the boundaries measured above.
    let bodyTemplate: string | null = null;
    let searchRoot: HTMLElement | null = row.parentElement;
    while (searchRoot && bodyTemplate === null) {
      for (const candidate of Array.from(
        searchRoot.querySelectorAll('[role="row"]')
      )) {
        if (candidate !== row && candidate.querySelector('[role="cell"]')) {
          bodyTemplate = getComputedStyle(candidate).gridTemplateColumns;
          break;
        }
      }
      searchRoot = searchRoot.parentElement;
    }

    // Walk to an ancestor that ACTUALLY clips. `scrollWidth > clientWidth` alone
    // is not enough: an `overflow: visible` box reports an overflowing child in
    // its scrollWidth too, so the walk used to stop at GridTable's own `w-full`
    // measured wrapper — the very box the fitter measured. Asserting the fold
    // against that is circular and would pass even if the real scroll container
    // clipped somewhere else entirely.
    const clippingOverflow = new Set(["auto", "scroll", "hidden", "clip"]);
    let scroller: HTMLElement | null = row.parentElement;
    while (scroller) {
      const { overflowX } = getComputedStyle(scroller);
      if (
        clippingOverflow.has(overflowX) &&
        scroller.scrollWidth > scroller.clientWidth
      ) {
        break;
      }
      scroller = scroller.parentElement;
    }
    if (!scroller) {
      return {
        boundariesPx,
        foldPx: 0,
        overflows: false,
        headerTemplate,
        bodyTemplate,
      };
    }

    // Where the scroller clips, expressed from the table row's own left edge —
    // which is what the cumulative track boundaries above are measured from.
    const clipRightPx =
      scroller.getBoundingClientRect().left +
      scroller.clientLeft +
      scroller.clientWidth;
    return {
      boundariesPx,
      bodyTemplate,
      foldPx: clipRightPx - row.getBoundingClientRect().left,
      headerTemplate,
      overflows: true,
    };
  });
}

/**
 * A header cell addressed by COLUMN ID rather than accessible name (ISS-6065).
 *
 * A reorderable column renders a drag grip named "Reorder <label> column, use
 * arrow keys" inside the same cell, so the header's accessible name is not its
 * label and `getByRole("columnheader", { name: "Started" })` matches nothing —
 * an absence assertion written that way can never fail, which is not coverage.
 * Same addressing as the web twin and `sessions-header-reorder-drag.spec.ts`.
 *
 * Deliberately NOT `:visible`-scoped: desktop keep-alive views stay
 * mounted-but-hidden and render a second copy of the same header row, and a
 * migrated column must be gone from every copy, not merely the on-screen one.
 */
function columnHeaderById(page: Page, columnId: string) {
  return page.locator(`[role="columnheader"][data-column-id="${columnId}"]`);
}

/**
 * Local SQLite token-event costs through the Desktop detail projection, with
 * real rail glyph measurements at the native pane width.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { gotoHash, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";
import {
  type PricedTokenEventSeed,
  seedPricedTokenEvents,
} from "./helpers/seed-priced-token-events";

const SESSION_ID = "019ecc00-5761-7c50-ac18-52cffa8b0001";
const SESSION_NAME = "Dense cost rail (ISS-5761)";

/** The session TITLE is the per-session barrier — the strip renders on every session. */
const SESSION_TITLE_SELECTOR = ".sd3-head h1";
/** The cost RAIL's per-bucket cells. Always one per bucket; a quiet cell is EMPTY, not absent. */
const BAR_LABEL_SELECTOR = ".sd3-bars2-lbls .sd3-bar2-lbl";
/** The bar row's per-bucket controls. */
const BAR_SELECTOR = ".sd3-bars2 .sd3-bar2";

const MOUNT_TIMEOUT_MS = 60_000;
const MINUTE_MS = 60_000;

/** One bucket per five minutes, per `SESSION_TRACE_BUCKET_TARGET`'s producer. */
const BUCKET_MINUTES = 5;

/** 200 minutes of activity → `ceil(200/5)` = the 40-column cap. */
const DENSE_SPAN_MINUTES = 200;

const DENSE_BUCKET_COUNT = DENSE_SPAN_MINUTES / BUCKET_MINUTES;

/**
 * The columns the strip RENDERS, which since ISS-5999 is no longer the
 * producer's bin count.
 *
 * ISS-5819's clock window is unconditional now: the strip is always
 * `TIMELINE_VISIBLE_COLUMNS` wide and the producer's bins are re-projected onto
 * it, so the bin count decides how much money lands in a column and no longer
 * decides how many columns there are. A literal rather than an import for the
 * same reason `MIN_GUTTER_PX` below is one — a desktop spec cannot import
 * `@repo/app` modules under Playwright's ESM loader — and the constant is pinned
 * by that module's own unit tests.
 */
const RENDERED_COLUMNS = 24;

const STARTED_AT_MS = Date.parse("2026-06-10T09:00:00.000Z");
/** Past the activity extent, so `clampToRange` never shrinks the window. */
const ENDED_AT_MS = STARTED_AT_MS + (DENSE_SPAN_MINUTES + 10) * MINUTE_MS;
const NOW_MS = Date.now();

/**
 * A viewport narrow enough that 40 columns genuinely cannot hold their figures.
 *
 * Set explicitly rather than inherited from the launched window because this
 * spec's claim IS about a width — the established carve-out in
 * `helpers/summary-strip.ts`, which warns only against re-measuring a synthetic
 * viewport when the claim is about the window's own geometry. The arithmetic:
 * `fitBucketBarLabels` needs `(w1 + w2) / 2 + 4px` of pitch between neighbours,
 * and a `$27.75` estimates ~35px wide, so 40 columns print only on a rail wider
 * than ~1570px. The detail pane inside this viewport is nowhere near that.
 */
const NARROW_VIEWPORT = { height: 900, width: 1280 };

/**
 * The reported session's cost band, mirrored from the jsdom regression so the
 * two describe ONE fixture: every bucket clears `getBarStyle`'s 16%-of-peak
 * label threshold (the cheapest is 31% of the peak), so the rail is asked to
 * print EVERY column and the suppression under test is the only thing that can
 * stop it. A fixture whose buckets fell under that threshold would thin the rail
 * for the wrong reason and the spec would pass without exercising the fix.
 */
function bucketCostUsd(index: number): number {
  return 8.55 + (index % 7) * 3.2;
}

/** The strip's most expensive bucket, formatted as the rail prints it. */
const DENSE_PEAK_LABEL = "$27.75";

function pricedEvents(
  bucketCount: number,
  costUsd: (index: number) => number
): PricedTokenEventSeed[] {
  return Array.from({ length: bucketCount + 1 }, (_, index) => {
    // The trailing anchor carries no money — see the header.
    const cost = index === bucketCount ? 0 : costUsd(index);
    return {
      createdAt: new Date(
        STARTED_AT_MS + index * BUCKET_MINUTES * MINUTE_MS
      ).toISOString(),
      inputCostUsd: cost * 0.5,
      outputCostUsd: cost * 0.3,
      cacheReadCostUsd: cost * 0.2,
      cacheCreationCostUsd: 0,
    } satisfies PricedTokenEventSeed;
  });
}

/**
 * Every printed rail label's INK box, in rail-relative px, plus the rail's width.
 *
 * Measured with a `Range` over each cell's contents rather than with the cell's
 * own `getBoundingClientRect`, and that distinction is the entire test.
 * `.sd3-bar2-lbl` is a `flex: 1 1 0` cell exactly as wide as the bar beneath it,
 * separated from its neighbour by the rail's 2px `gap` — so ELEMENT rects are 2px
 * apart no matter what they contain, and an element-rect collision check reports
 * "no overlap" on the very strip that renders `$724.0`. The text is
 * `white-space: nowrap` and nothing in the rail clips, so the glyphs spill
 * outside that box; `Range.getBoundingClientRect()` returns the painted glyph run
 * itself, which is what a reader sees colliding.
 *
 * This is the real flex geometry, the real font metrics and the real
 * `tabular-nums` advance in the launched renderer — the measurement jsdom cannot
 * make, and the reason this spec exists.
 *
 * Empty cells are excluded by TEXT, not by element: the rail always renders one
 * cell per bucket (that is what holds the strip's height steady across a
 * resize), so a quiet rail is 40 empty spans, not 0 spans.
 */
async function measurePrintedLabels(page: Page): Promise<{
  cells: number;
  railWidth: number;
  printed: { left: number; right: number; text: string }[];
}> {
  return await page.evaluate(
    ({ labelSelector }) => {
      const rail = document.querySelector(".sd3-bars2-lbls");
      const railRect = rail?.getBoundingClientRect();
      const railLeft = railRect ? railRect.left : 0;
      const all = [...document.querySelectorAll(labelSelector)];
      return {
        cells: all.length,
        railWidth: railRect ? railRect.width : 0,
        printed: all
          .filter((cell) => (cell.textContent ?? "").trim().length > 0)
          .map((cell) => {
            const range = document.createRange();
            range.selectNodeContents(cell);
            const rect = range.getBoundingClientRect();
            return {
              left: rect.left - railLeft,
              right: rect.right - railLeft,
              text: (cell.textContent ?? "").trim(),
            };
          }),
      };
    },
    { labelSelector: BAR_LABEL_SELECTOR }
  );
}

/**
 * The property the fix exists to guarantee: no two printed figures touch, and
 * none spills out of the rail.
 *
 * `BAR_LABEL_MIN_GUTTER_PX` in
 * `packages/app/agents/components/detail/session-timeline-bar-label-fit.ts` is 4
 * — labels that merely fail to OVERLAP still read as one run, which is what the
 * reported `$8.55$15.3$20.20` was. Copied as a literal because a desktop spec
 * cannot import `@repo/app` UI modules under Playwright's ESM loader; the source
 * constant is pinned by the fit module's own unit test.
 */
const MIN_GUTTER_PX = 4;

function expectNoCollision(
  measured: Awaited<ReturnType<typeof measurePrintedLabels>>
): void {
  const { printed, railWidth } = measured;
  // Neighbour clearance FIRST: two figures running together is the reported
  // defect itself (`$724.0` is `$7` and `$24.0` touching), so it is the failure
  // a regression should report.
  for (const [index, label] of printed.entries()) {
    const previous = printed[index - 1];
    if (previous) {
      expect(
        label.left - previous.right,
        `"${previous.text}" and "${label.text}" are not separated`
      ).toBeGreaterThanOrEqual(MIN_GUTTER_PX);
    }
  }
  // Then the rail's own edges: nothing here clips, so a wide figure in the first
  // or last cell spills out of the strip and into the panel beside it — a run of
  // two labels is not the only way this rail can overflow.
  for (const label of printed) {
    expect(
      label.left,
      `"${label.text}" spills past the rail's left edge`
    ).toBeGreaterThanOrEqual(-0.5);
    expect(
      label.right,
      `"${label.text}" spills past the rail's right edge`
    ).toBeLessThanOrEqual(railWidth + 0.5);
  }
}

test.describe("Session Timeline cost rail density (ISS-5761 desktop adapter)", () => {
  test("prints the peak alone at a normal detail width, with nothing colliding", async () => {
    test.setTimeout(240_000);

    await withSeededSession(
      { bucketCount: DENSE_BUCKET_COUNT, prefix: "desktop-rail-dense" },
      async (page) => {
        const measured = await measurePrintedLabels(page);

        // POSITIVE CONTROL, first: the strip is genuinely on screen at its full
        // width. If the window had rendered a handful of columns, the
        // no-collision assertion below would pass on a rail that was never
        // crowded and this spec would be testing nothing.
        expect(measured.cells).toBe(RENDERED_COLUMNS);
        await expect(page.locator(BAR_SELECTOR)).toHaveCount(RENDERED_COLUMNS);
        // And genuinely too narrow to print them: the width the rail actually
        // measured is below what 40 of these figures need.
        expect(measured.railWidth).toBeGreaterThan(0);
        expect(measured.railWidth).toBeLessThan(1570);

        // THE claim, asserted first because it is the defect: whatever the rail
        // chose to print, the printed glyph runs clear each other. Before the
        // fix this is 40 figures at a ~22px pitch and they overlap.
        expectNoCollision(measured);

        // And the shape of the choice: one figure, and it is the peak — not an
        // arbitrary survivor, which is what would make the rail ambiguous again.
        expect(measured.printed.map((label) => label.text)).toEqual([
          DENSE_PEAK_LABEL,
        ]);
      }
    );
  });
});

/**
 * Launch the built app twice against ONE temp profile — once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real local session-detail
 * read projects the seeded corpus at boot.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only session on the surface is the seeded one.
 */
async function withSeededSession(
  {
    bucketCount,
    costUsd = bucketCostUsd,
    prefix,
  }: {
    bucketCount: number;
    costUsd?: (index: number) => number;
    prefix: string;
  },
  run: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };
  const spanMinutes = bucketCount * BUCKET_MINUTES;

  try {
    const first = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedSessionsList(userDataDir, [
      {
        // The ONE lever that moves the PROJECTED `lastActivityAt`, which the
        // sync source re-derives per row; without it the activity extent
        // collapses and the producer emits a single bucket.
        activityEventAt: new Date(
          STARTED_AT_MS + spanMinutes * MINUTE_MS
        ).toISOString(),
        at: new Date(STARTED_AT_MS).toISOString(),
        endedAt: new Date(ENDED_AT_MS).toISOString(),
        estimatedCost: 4.82,
        lastActivityAt: new Date(NOW_MS).toISOString(),
        name: SESSION_NAME,
        sessionId: SESSION_ID,
      },
    ]);
    await seedPricedTokenEvents(
      userDataDir,
      SESSION_ID,
      pricedEvents(bucketCount, costUsd)
    );

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await page.setViewportSize(NARROW_VIEWPORT);
      await gotoHash(page, `/sessions/${SESSION_ID}`);
      await expect(page.locator(SESSION_TITLE_SELECTOR)).toHaveText(
        SESSION_NAME,
        { timeout: MOUNT_TIMEOUT_MS }
      );
      // The rail is a layout-effect measurement, so wait for the cells to exist
      // before reading rects out of them.
      await expect(page.locator(BAR_LABEL_SELECTOR).first()).toBeAttached({
        timeout: MOUNT_TIMEOUT_MS,
      });
      await run(page);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
}

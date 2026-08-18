/**
 * Real-surface regression coverage for the Sessions list's LAYOUT and SEMANTIC
 * contracts, on the ELECTRON adapter. The web twin lives at
 * `e2e/sessions-table-legibility.spec.ts` — both shells mount the same shared
 * `SessionsTable` / `SessionsSummaryCards` out of `packages/app`, but they feed
 * them from entirely different producers (the cloud list projection on web, the
 * local SQLite read over IPC here) and lay them out in different hosts (the web
 * page owns a tagged scroll container and an auto-fit card grid; the desktop
 * renderer owns an untagged scroller, and since #4270 both hosts share the same
 * auto-fit `SUMMARY_CARD_GRID_CLASS` strip over different content widths). Per
 * `apps/desktop/AGENTS.md` a renderer UI fix needs a real-surface regression on
 * EACH adapter, not one plus an assumption — the layout arithmetic in particular
 * cannot transfer, because the two shells give the same table a different content
 * width.
 *
 * Four fixes converge on this one seeded surface, so they share ONE Electron
 * launch pair rather than paying four. Electron launches dominate this suite's
 * wall clock (two per seeded spec, ~30s each), and all four assertions read the
 * SAME rendered Sessions screen at the SAME viewport — splitting them into four
 * `test()` blocks would quadruple the launches to re-render an identical page.
 * The four groups below are therefore sections of one test, each with its own
 * heading and its own vacuity guard so a failure still names one ticket.
 *
 * - ISS-4891 (fix ISS-4788, PR #4230) — the Cost column used to sit sixth, so its
 *   track spanned x≈1120–1220 against the ~1,108px the 1380px window this spec
 *   pins leaves after the 256px sidebar: the fold landed inside it and a row's headline
 *   number painted as "$772.3" even though the DOM held "$772.39". Cost is now
 *   third (right edge 712px). The shipped regression is a jsdom test that sums
 *   `gridTemplateColumns` tracks; jsdom runs no layout engine, so it never
 *   exercises the real scroll container, sidebar, or auto-layout that produced the
 *   clip. This asserts the RENDERED Cost cell's box sits inside the real scroll
 *   container's visible area at rest and that its text is undivided.
 *
 * - ISS-4888 (fix ISS-4787, PR #4223, completed by #4270) — a summary-strip card
 *   whose label needed more lines than its peers started its value a line-height
 *   below them. The shipped regression is a jsdom test that can only assert the
 *   reservation classes are present; jsdom lays out no text, so it stays green if
 *   the real strip is still staggered. This measures the rendered label and value
 *   nodes and asserts the reservation as the equation it is — the row publishes
 *   `max(lines) × 16px` (ISS-4887's derived floor, un-gated by ISS-5062) and
 *   every card's label region IS that published value — plus the floor that
 *   equation depends on and a shared value baseline within each comparable group
 *   (same visual row, same label-region height). Both halves are asserted
 *   because at these widths every label is one line, and in a uniform rank the
 *   per-card half alone would hold with the reservation deleted; the published
 *   property is what separates a derived 16px from the class's retired fixed
 *   `2rem` CSS fallback.
 *
 *   It deliberately does NOT require any label to wrap. An earlier cut did, and
 *   that premise is false on both adapters: #4270 made the strips derive their
 *   columns from the published `--summary-card-min` — 260px at comfortable
 *   density, 192px at compact since ISS-5366 retired the density gate — and at
 *   every card width the auto-fit grid then produces (the compact strip lays
 *   ~207px cards at this window) "cost" renders on ONE line. Requiring a wrap asserted the
 *   PRE-#4270 desktop layout, where a pinned `xl:grid-cols-5` left each card
 *   206px and the label took a THIRD line. So the two directions that regression
 *   can return from are asserted instead: no card narrower than the floor, and no
 *   label past the two lines the floor reserves. Both are font-metric independent,
 *   which the wrap guard never was.
 *
 * - ISS-4770 (fix ISS-4672, PR #4156) — the shared GridTable's ARIA table
 *   semantics are covered only by a mounted Vitest + axe unit test. This asserts
 *   the roles, the header/body `aria-colindex` pairing, and the named label-less
 *   row-actions column through the real Electron route.
 *
 * - ISS-5840 — the Cost column's pill. The shipped regression is a jsdom class
 *   scan, which can see neither a chip's SHAPE (all of it is CSS) nor a computed
 *   `text-overflow`, and the ISS-4891 cohort above is single-billing-mode, so it
 *   never reaches the branch that drew the pill: `renderTooltipChip` was keyed on
 *   the row having a TOOLTIP, and only subscription-covered spend has one. Two
 *   extra seeded rows make the column mixed, and the section asserts the chip is
 *   gone, that the explained and unexplained rows read as one treatment, and that
 *   the surviving explanation is still reachable by keyboard.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

// A DELIBERATELY NARROW window, not the launch default — do not swap this for
// `DEFAULT_WINDOW_WIDTH`. 1380 is the configuration ISS-4788 was reported at,
// and the tightest regime the Cost column has to stay legible in; pinning it
// measures the fold at the reported width on any runner display, and keeps this
// spec honest after the default was widened to 1400 (which only gives Cost more
// room, so tracking the default would weaken the assertion).
const DESKTOP_VIEWPORT = { height: 900, width: 1380 };

// The exact figure from the ISS-4788 report. Asserted as a whole string so a
// re-clip that paints "$772.3" fails on the text, not only on the geometry.
const HEADLINE_COST = 772.39;
const HEADLINE_COST_TEXT = "$772.39";
const COST_COLUMN_ID = "cost";
const COST_COLUMN_LABEL = "Cost";

// SESSIONS_COST_METRIC_CARD_LABEL (packages/app/agents/components/sessions/
// cost-metric-card.tsx). Pinned as a literal rather than imported: that module is
// a `.tsx` component that pulls the design system and the app runtime behind it,
// and a `@repo/app/…` component specifier only resolves through the renderer's
// vite alias, not this spec's Node runtime — importing it aborts the WHOLE
// Electron suite at load. `sessions-list-dbseed.spec.ts` mirrors the same literal
// for the same reason; keep all three in sync if the label ever changes.
const SESSIONS_COST_METRIC_CARD_LABEL = "cost";

// ISS-4787's reservation (`SummaryCardRow` in packages/app/shared/components/
// summary-card-row.tsx) gives every card in the strip the SAME label-region
// height, and pins its line box to `leading-4` (1rem) so a label's NATURAL
// height is `lines × 16`.
//
// ISS-5062: that shared height is the ISS-4887 DERIVED one — the tallest label
// region actually rendered in the row — not the fixed `min-h-8` two-line floor
// this spec used to encode. `derivedLabelReservationPx` below is the row's own
// `max(lines) × 16`, which is 32 when a label wrapped and 16 when none did.
// Pinning 32 unconditionally was only green because the derivation sat behind
// `summary-strip-label-baseline`, which resolves OFF in the harness while it was
// ON at 100% for real users. Because every label is one line in this pane, that
// equation alone would now hold with the reservation deleted, which is why the
// PUBLISHED property below is asserted alongside it.
const LABEL_LINE_HEIGHT_PX = 16;
// `SUMMARY_CARD_LABEL_MIN_PROPERTY` (packages/app/shared/hooks/
// use-summary-label-baseline.ts): the property the row publishes its DERIVED
// reservation on, and the one the label class floors to. Pinned as a literal for
// the same reason the label and the floor are — a Playwright spec cannot import
// an app-runtime module. Reading it is what makes the equation non-vacuous in a
// pane where every label is one line: the class's CSS fallback is the retired
// fixed `2rem`, so a row that stopped deriving reports 32 where it reports 16.
const SUMMARY_CARD_LABEL_MIN_PROPERTY = "--summary-card-label-min";
// Sub-pixel rounding on a measured box, and the hook's own `Math.ceil` on the
// value it publishes.
const LABEL_HEIGHT_TOLERANCE_PX = 1;
// The two lines the strip's per-card floor is SIZED for: the longest label the
// strip ships holds two at `--summary-card-min` (ISS-4787). A third means the
// cards came out narrower than that floor assumes — the desktop regression
// #4270 fixed by deriving the strip's columns from the per-card floor below.
// Since ISS-4887 a third line no longer staggers the rank (the derived
// reservation grows with it, so every card gets the taller region), but it does
// cost every card that line, so it stays pinned as the width signal it is.
const RESERVED_LABEL_MAX_LINES = 2;
// The two per-card floors `SummaryCardRow` can publish on `--summary-card-min`
// (`DEFAULT_CARD_MIN_WIDTH` / `DENSE_CARD_MIN_WIDTH`, packages/app/shared/
// components/summary-card-row.tsx). Pinned as literals for the same reason the
// label is: that module is app-runtime `.tsx` a Playwright spec cannot import.
//
// ISS-5366 (wongk review): this spec used to compare every card against the 260
// COMFORTABLE floor alone, which only held while the density tier sat behind a
// Labs gate that resolved off here. With the gate retired the tier is
// unconditional, and at the desktop launch width the strip measures a 1099px
// track that cannot hold five comfortable cards, so it legitimately publishes
// the 192px compact floor and lays ~207px cards. A fixed 260 rejects the shipped
// layout. So the card is compared against the floor the row ACTUALLY published,
// and that published value is itself pinned to one of the two legal floors —
// strictly stronger than the old literal, since it still catches a card narrower
// than its own floor and additionally catches a row publishing a floor neither
// density owns.
const SUMMARY_CARD_COMFORTABLE_MIN_WIDTH_PX = 260;
const SUMMARY_CARD_COMPACT_MIN_WIDTH_PX = 192;
const SUMMARY_CARD_LEGAL_MIN_WIDTHS_PX = [
  SUMMARY_CARD_COMPACT_MIN_WIDTH_PX,
  SUMMARY_CARD_COMFORTABLE_MIN_WIDTH_PX,
] as const;
// `SUMMARY_CARD_MIN_PROPERTY` (packages/app/shared/hooks/
// use-summary-card-columns.ts): the property the row publishes its resolved
// per-card floor on. Pinned as a literal for the same reason the others are.
const SUMMARY_CARD_MIN_PROPERTY = "--summary-card-min";
// Sub-pixel rounding on a measured track; the floor is a floor, not a target.
const CARD_WIDTH_TOLERANCE_PX = 1;
// Sub-pixel rounding across differently-sized siblings; anything at or beyond a
// line-height (16px) is the ISS-4787 stagger this pins.
const BASELINE_TOLERANCE_PX = 2;
// Cards are grouped into visual rows by their own top edge before their values
// are compared, so the strip's wrapping grid does not read as a baseline break.
const ROW_GROUPING_TOLERANCE_PX = 4;
// The floor the requested window has to clear for the table beneath to keep its
// full column set. Both reported defects are layout arithmetic at the desktop
// default window, so the width is asserted rather than assumed: the runner's
// display can refuse the request, and a narrower fallback would silently measure
// a different regime than the one reported. ISS-5068 sized the `desktop-e2e`
// xvfb screen past the app's default window, so the request is now granted in
// full; this floor stays as the guard that says so if that ever regresses.
const WIDE_STRIP_BREAKPOINT_PX = 1280;

// ISS-5840 ── the mixed-billing pair. A subscription mode
// (`SUBSCRIPTION_BILLING_MODES`, packages/api/src/types/billing-mode.ts) is the
// only branch that carries a Cost tooltip, and the tooltip is what used to draw
// the pill; a metered mode is the `$1.01`-shaped row that never did. Both modes
// are pinned as literals for the same reason the labels above are — a Playwright
// spec cannot import an app-runtime module. `sessions-cost-billing-honesty.spec.ts`
// pins the same two values.
const SUBSCRIPTION_BILLING_MODE = "max_20x";
const METERED_BILLING_MODE = "api";
const SUBSCRIPTION_COST = 658.29;
const SUBSCRIPTION_COST_TEXT = "$658.29";
const PLAIN_API_COST = 1.01;
const PLAIN_API_COST_TEXT = "$1.01";
// `COST_TOOLTIP[Subscription]` (packages/app/agents/lib/cost-availability.ts) —
// the explanation that used to arrive wrapped in a chip.
const SUBSCRIPTION_TOOLTIP = "Billed through your subscription";
// `SESSION_COST_CELL_TEST_ID` (packages/app/agents/components/sessions/
// session-cost-cell.tsx).
const COST_CELL_TEST_ID = "session-cost-cell";
// The three marks `Chip variant="outline"` puts on its box — pill SHAPE, chip
// BACKGROUND, chip BORDER — none of which may survive inside a Cost cell.
const CHIP_CLASSES = ["rounded-full", "bg-input", "border-input-border"];

const CARD_SELECTOR = '[data-slot="card"]:visible';
const CARD_TITLE_SELECTOR = '[data-slot="card-title"]';
const CARD_DESCRIPTION_SELECTOR = '[data-slot="card-description"]';
const COLCOUNT_PATTERN = /^\d+$/;
const MOUNT_TIMEOUT_MS = 30_000;

// One headline row carrying the reported figure plus five modest-cost rows, so
// the summary strip and the grid both populate from the same corpus.
const HEADLINE_SESSION_NAME = "ISS-4891 headline cost session";
const SEEDED_SESSIONS: SessionListSeed[] = [
  {
    estimatedCost: HEADLINE_COST,
    name: HEADLINE_SESSION_NAME,
    sessionId: "iss-4891-headline-cost",
  },
  ...Array.from({ length: 5 }, (_value, offset) => ({
    estimatedCost: 12.5 + offset,
    name: `ISS-4891 layout session ${offset + 2}`,
    sessionId: `iss-4891-layout-${offset + 2}`,
  })),
  // ISS-5840: the two rows that make the Cost column MIXED. Their magnitudes are
  // deliberately of the same order as the layout cohort above, because this pane
  // is shared with the ISS-4888 summary-strip assertions and an outsized figure
  // would move the strip's own geometry.
  {
    billingMode: SUBSCRIPTION_BILLING_MODE,
    estimatedCost: SUBSCRIPTION_COST,
    name: "ISS-5840 subscription-covered session",
    sessionId: "iss-5840-subscription",
  },
  {
    billingMode: METERED_BILLING_MODE,
    estimatedCost: PLAIN_API_COST,
    name: "ISS-5840 API-billed session",
    sessionId: "iss-5840-api",
  },
];

/** What the rendered Cost cell's geometry says about the real scroll container. */
type CostCellLayout = {
  cellClearsLeftEdge: boolean;
  cellClearsRightEdge: boolean;
  cellWithinWindow: boolean;
  /** False when no clipping ancestor was found — a vacuous measurement. */
  foundScroller: boolean;
  /** At rest nobody has scrolled, so the cell must already be on screen. */
  restingScrollLeft: number | null;
  textOverflows: boolean;
};

/** One summary-strip card's measured label/value geometry. */
type CardMeasurement = {
  cardTop: number;
  /**
   * The card's own rendered width. ISS-4787's reservation only holds while a
   * card is at least `--summary-card-min` wide, so the width is measured rather
   * than assumed — it is the input the whole equation depends on.
   */
  cardWidth: number;
  /**
   * The per-card floor the ROW resolved and published on `--summary-card-min`,
   * as the card sees it. `NaN` when nothing was published, so the comparisons
   * fail loudly instead of passing on an unpublished floor.
   */
  cardMinPx: number;
  labelHeight: number;
  labelLineCount: number;
  /**
   * The reservation the ROW published on `--summary-card-label-min`, as the card
   * sees it. `NaN` when nothing was published, so the comparison fails loudly
   * instead of degrading to the class's CSS fallback unnoticed.
   */
  labelMinPx: number;
  labelText: string;
  valueTop: number | null;
};

/** The paired ARIA facts the shared GridTable must expose on the real route. */
type GridSemantics = {
  colcountMatchesHeaderCount: boolean;
  costCellsMatchHeaderIndex: boolean;
  everyCellHasColindex: boolean;
  everyCellIsInsideARow: boolean;
  everyHeaderHasColindex: boolean;
  everyHeaderIsNamed: boolean;
  sortableHeadersDeclareSort: boolean;
};

test.describe("Sessions table legibility (ISS-4891 / ISS-4888 / ISS-4770)", () => {
  test("the Sessions list renders Cost undivided, aligns strip values, and exposes paired ARIA semantics", async () => {
    test.setTimeout(180_000);

    // Empty CLAUDE_HOME/CODEX_HOME so the boot collectors ingest nothing and the
    // only rows are the seeded ones (mirrors sessions-column-fold.spec.ts).
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-table-legibility-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-table-legibility-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-table-legibility-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, then close so the seed
      // writes without cross-process WAL contention (a running app does not
      // observe another process's writes to its own store).
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
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await openSeededSessionsList(page);

        // ── ISS-4891 ── the Cost cell is whole and inside the visible area ──
        const costCell = page
          .locator(`[role="cell"][data-column-id="${COST_COLUMN_ID}"]`)
          .locator("visible=true")
          .filter({ hasText: HEADLINE_COST_TEXT })
          .first();
        await expect(costCell).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        // The DOM holds the whole number, undivided — the pre-fix clip still had
        // the full text here, so this alone is not the regression; the geometry
        // below is.
        await expect(costCell).toHaveText(HEADLINE_COST_TEXT);

        // Polled, not read once: the column fitter measures its container through
        // a ResizeObserver, so the first painted frame can carry the declared
        // template rather than the fitted one. `expect.poll` re-reads until the
        // layout settles (or the expect timeout expires) — a stable-state wait,
        // never a fixed delay.
        //
        // ISS-5315 moved Cost from the third slot ISS-4788 gave it to the tenth,
        // so the default view now leaves it past the horizontal fold. That is the
        // reviewed product order, and it is only safe because ISS-4889's
        // `snapFoldToColumns` renders a column WHOLE or not at all — which is
        // precisely what ISS-4891 is about. So the contract splits in two rather
        // than relaxing: AT REST the grid must not auto-scroll and the cell must
        // already hold its whole value undivided…
        await expect
          .poll(() => readCostCellAtRest(costCell), {
            timeout: MOUNT_TIMEOUT_MS,
          })
          .toEqual({
            cellClearsLeftEdge: true,
            foundScroller: true,
            restingScrollLeft: 0,
            textOverflows: false,
          });

        // …and once ISS-4901's scroll affordance brings it in, the cell sits
        // wholly inside both the scroller and the window — the two dimensions
        // deliberately left unpinned at rest above, because pinning them there
        // would pin Cost's fold-relative POSITION rather than its legibility.
        await costCell.scrollIntoViewIfNeeded();
        await expect
          .poll(() => readCostCellOnScreen(costCell), {
            timeout: MOUNT_TIMEOUT_MS,
          })
          .toEqual({
            cellClearsLeftEdge: true,
            cellClearsRightEdge: true,
            cellWithinWindow: true,
            foundScroller: true,
            textOverflows: false,
          });

        // ── ISS-4888 ── the summary strip's values share one baseline per row ──
        const wrappingLabelCard = page
          .locator(CARD_SELECTOR)
          .filter({ hasText: SESSIONS_COST_METRIC_CARD_LABEL })
          .first();
        await expect(wrappingLabelCard).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        // Measure the STRIP, not every card on the page: below `xl` the table
        // beneath falls back to a card list, and those rows carry the same
        // `data-slot="card"`. The strip is the reported card's own grid parent.
        const summaryStrip = wrappingLabelCard.locator("xpath=..");
        // Where a label breaks depends on the metrics of the font actually in
        // use, so measure only once webfont swap-in can no longer reflow the
        // strip. `document.fonts.ready` is the browser's own settled signal — a
        // stable state to await, not a guessed delay.
        await page.evaluate(() => document.fonts.ready);

        const measurements = await readStripMeasurements(summaryStrip);
        const measured = measurements.filter(
          (card): card is CardMeasurement & { valueTop: number } =>
            card.valueTop !== null
        );
        // Vacuity guard 1: a baseline comparison needs siblings to compare.
        expect(measured.length).toBeGreaterThan(1);

        // Vacuity guard 2: the reported card is in the strip and its label was
        // really measured. A zero line count means the TEXT-NODE range found
        // nothing, which would make the reservation equation below pass on
        // `0 × 16` for every card.
        const costCard = measured.find(
          (card) => card.labelText === SESSIONS_COST_METRIC_CARD_LABEL
        );
        expect(costCard).toBeDefined();
        expect(
          measured
            .filter((card) => card.labelLineCount < 1)
            .map((c) => c.labelText)
        ).toEqual([]);

        // ISS-4787's floor, as the precondition it is. The reservation reserves
        // TWO lines, so it only holds while every card is wide enough that the
        // longest shipped label cannot need a THIRD — which is exactly the
        // 260px `--summary-card-min` the strip now derives its columns from
        // (#4270). Beside the 16rem rail the desktop strip used to pin
        // `lg:grid-cols-3 xl:grid-cols-5` instead, leaving each card 206px: the
        // label took a third line, its region grew to 48px against every
        // sibling's 32px, and its value sat one whole `leading-4` box below the
        // rank. Both halves of that are asserted — no card under the floor, and
        // no label past the two lines the floor reserves — so a revert of #4270
        // fails here on the real rendered geometry rather than on a class name.
        // The row published a floor one of its two densities actually owns.
        // Without this the width check would be satisfied by a row that
        // published nothing (NaN) and then laid cards to match it.
        const illegalFloors = measured
          .filter(
            (card) =>
              !SUMMARY_CARD_LEGAL_MIN_WIDTHS_PX.some(
                (legal) =>
                  Math.abs(card.cardMinPx - legal) <= CARD_WIDTH_TOLERANCE_PX
              )
          )
          .map((card) => `${card.labelText}: published ${card.cardMinPx}px`);
        expect(illegalFloors).toEqual([]);
        const underFloorCards = measured
          .filter(
            (card) => card.cardWidth < card.cardMinPx - CARD_WIDTH_TOLERANCE_PX
          )
          .map(
            (card) =>
              `${card.labelText}: ${Math.round(card.cardWidth)}px against a ${card.cardMinPx}px floor`
          );
        expect(underFloorCards).toEqual([]);
        const overflowingLabels = measured
          .filter((card) => card.labelLineCount > RESERVED_LABEL_MAX_LINES)
          .map((card) => `${card.labelText}: ${card.labelLineCount} line(s)`);
        expect(overflowingLabels).toEqual([]);

        // The reservation itself, in TWO halves, because since ISS-5062 one half
        // alone can pass on nothing.
        //
        // HALF ONE — the row PUBLISHED the derived reservation. Load-bearing in
        // this pane: every label is one line here (the header says so), and in a
        // uniform rank `max(lines) × 16` IS each card's own natural height, so
        // the per-card half below would hold with the reservation deleted
        // outright. The published property separates a derived 16 from the
        // class's CSS fallback — the retired fixed `2rem` — so a row that
        // stopped deriving reports 32 and fails. Tolerance is the hook's ceil.
        const reservedLabelHeight = derivedLabelReservationPx(measured);
        const unpublishedReservations = measured
          .filter(
            (card) =>
              !(
                Math.abs(card.labelMinPx - reservedLabelHeight) <=
                LABEL_HEIGHT_TOLERANCE_PX
              )
          )
          .map(
            (card) =>
              `${card.labelText}: published ${card.labelMinPx}px for a derived ${reservedLabelHeight}px`
          );
        expect(unpublishedReservations).toEqual([]);
        // HALF TWO — every card's region actually IS that reservation, so no
        // card renders its label at its own natural height and drops its value
        // off the rank. Compared against the PUBLISHED value rather than the
        // computed one so the hook's `Math.ceil` cannot flake this on a
        // fractional line box. The web twin asserts both halves.
        const labelHeightMismatches = measured
          .filter(
            (card) =>
              Math.abs(card.labelHeight - card.labelMinPx) >
              LABEL_HEIGHT_TOLERANCE_PX
          )
          .map(
            (card) =>
              `${card.labelText}: ${card.labelHeight}px against a ${card.labelMinPx}px reservation for ${card.labelLineCount} line(s)`
          );
        expect(labelHeightMismatches).toEqual([]);

        // The stagger itself. The desktop strip is
        // `grid-cols-1 lg:grid-cols-3 xl:grid-cols-5`, so it can wrap onto
        // several visual rows and only cards in the SAME rank share a baseline;
        // and `SummaryCardRow` documents the floor as a floor, not a clamp — a
        // label that genuinely needs a THIRD line still gets it and that card
        // alone gives up the shared baseline. So cards are grouped by rank AND by
        // label-region height, and every group is required to share one value
        // top. Because the reservation puts one-line and two-line labels at the
        // SAME height, that grouping is exactly the set the fix promises to align.
        const rankSpreads = measureRankSpreads(measured);
        expect(rankSpreads.length).toBeGreaterThan(0);
        for (const spread of rankSpreads) {
          expect(spread).toBeLessThanOrEqual(BASELINE_TOLERANCE_PX);
        }

        // ── ISS-4770 ── the grid's ARIA table semantics on the real route ──
        // Located by column id, not by accessible name: a reorderable header's
        // name also carries its drag handle's ("Reorder Cost column, use arrow
        // keys Cost"), so an exact-name match finds nothing.
        const costHeader = page
          .locator(`[role="columnheader"][data-column-id="${COST_COLUMN_ID}"]`)
          .locator("visible=true")
          .first();
        await expect(costHeader).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        // …and that header is the one a reader sees as "Cost": its sort control
        // carries the visible column label as its own accessible name.
        await expect(
          costHeader.getByRole("button", {
            exact: true,
            name: COST_COLUMN_LABEL,
          })
        ).toHaveCount(1);

        const table = costHeader.locator('xpath=ancestor::*[@role="table"][1]');
        await expect(table).toHaveAttribute("aria-colcount", COLCOUNT_PATTERN);

        const semantics = await readGridSemantics(table, COST_COLUMN_ID);
        expect(semantics).toEqual({
          colcountMatchesHeaderCount: true,
          costCellsMatchHeaderIndex: true,
          everyCellHasColindex: true,
          everyCellIsInsideARow: true,
          everyHeaderHasColindex: true,
          everyHeaderIsNamed: true,
          sortableHeadersDeclareSort: true,
        });

        // ── ISS-5840 ── one plain treatment across mixed billing modes ──
        // The Electron half of the guardrail: the shared `SessionsTable` mounts
        // here too, and the chip's SHAPE is entirely CSS, which the jsdom twin
        // (`sessions-table-cost-plain-text.test.tsx`) cannot see. The cohort is
        // mixed on purpose — `renderTooltipChip` was keyed on the row having a
        // TOOLTIP, and only subscription-covered spend has one, so a
        // single-billing-mode cohort never reaches the branch that drew the pill.
        const subscriptionCost = costCellForText(page, SUBSCRIPTION_COST_TEXT);
        const apiCost = costCellForText(page, PLAIN_API_COST_TEXT);
        await expect(subscriptionCost).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(apiCost).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await subscriptionCost.scrollIntoViewIfNeeded();

        for (const chipClass of CHIP_CLASSES) {
          await expect(subscriptionCost.locator(`.${chipClass}`)).toHaveCount(
            0
          );
        }
        // The explained and unexplained rows now read as ONE column. Pinned to
        // literals as well as to each other: two identical reads off two missing
        // nodes would also compare equal, and `clip` is the ISS-4891
        // no-ellipsis contract a returning `truncate` would report as
        // `ellipsis` (wongk review — the width leg of that contract is measured
        // on the web adapter, whose cohort is not shared with this pane's
        // summary-strip assertions and can therefore afford an outsized figure).
        const [subscriptionTreatment, apiTreatment] = await Promise.all([
          readCostTextTreatment(subscriptionCost),
          readCostTextTreatment(apiCost),
        ]);
        expect(subscriptionTreatment).toEqual(apiTreatment);
        expect(subscriptionTreatment).toEqual({
          fontVariantNumericHasTabularNums: true,
          textOverflow: "clip",
        });

        // The chip supplied `interactive tabIndex={0}`; the plain trigger has to
        // earn that back or the surviving explanation becomes hover-only.
        const subscriptionTrigger = subscriptionCost.getByRole("button", {
          name: SUBSCRIPTION_COST_TEXT,
        });
        await expect(subscriptionTrigger).toBeVisible();
        await subscriptionTrigger.focus();
        await expect(
          page.getByRole("tooltip").filter({ hasText: SUBSCRIPTION_TOOLTIP })
        ).toBeVisible();
        // The unexplained row does NOT become a control — a tab stop that opens
        // nothing is a keyboard cost for no reader benefit.
        await expect(apiCost.getByRole("button")).toHaveCount(0);

        // Screenshot into Playwright's per-test output dir (portable across
        // machines/CI; CI uploads test-results-e2e/ on failure).
        await page.screenshot({
          fullPage: true,
          path: test.info().outputPath("sessions-table-legibility.png"),
        });

        // No uncaught renderer errors (a blanked chunk would also fail the above).
        expect(pageErrors).toEqual([]);
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
 * Drive the renderer to the seeded Sessions list at the reported window size and
 * wait until the headline row is on screen.
 *
 * The date-range widen is not optional: the Sessions toolbar defaults to a narrow
 * window, and `:visible` scopes the control to the ACTIVE Sessions toolbar —
 * desktop keep-alive views stay mounted-but-hidden and render the same control.
 */
async function openSeededSessionsList(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await gotoNav(page, "sessions");
  await page.locator('[aria-label="All time"]:visible').click();
  await expect(
    page.getByRole("link", { name: HEADLINE_SESSION_NAME })
  ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  // The requested viewport is a request, not a guarantee — so the regime BOTH
  // defects were reported in is asserted rather than assumed (see
  // WIDE_STRIP_BREAKPOINT_PX). Read after the row lands so the window has
  // finished settling.
  await expect
    .poll(() => page.evaluate(() => globalThis.innerWidth), {
      timeout: MOUNT_TIMEOUT_MS,
    })
    .toBeGreaterThanOrEqual(WIDE_STRIP_BREAKPOINT_PX);
}

/**
 * Measure the rendered Cost cell against the real scroll container.
 *
 * The desktop shell tags no scroll container (unlike the web page, which owns a
 * `data-testid`), so the walk finds the nearest ancestor that ACTUALLY clips.
 * `scrollWidth > clientWidth` alone is not enough: an `overflow: visible` box
 * reports an overflowing child in its own `scrollWidth` too, so the walk would
 * stop at GridTable's `w-full` measured wrapper — the very box the column fitter
 * measured — and asserting the cell against that is circular.
 */
async function readCostCellLayout(costCell: Locator): Promise<CostCellLayout> {
  return await costCell.evaluate((cell): CostCellLayout => {
    const clippingOverflow = new Set(["auto", "scroll", "hidden", "clip"]);
    let scroller: HTMLElement | null = cell.parentElement;
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

    const rect = cell.getBoundingClientRect();
    // Any descendant whose text is wider than its box is a clip inside the cell,
    // which the whole-string assertion in the test body would not catch.
    const textOverflows = [...cell.querySelectorAll<HTMLElement>("*")].some(
      (node) => node.scrollWidth > node.clientWidth + 1
    );

    if (!scroller) {
      return {
        cellClearsLeftEdge: false,
        cellClearsRightEdge: false,
        cellWithinWindow: rect.left >= -1,
        foundScroller: false,
        restingScrollLeft: null,
        textOverflows,
      };
    }

    // The scroller's VISIBLE box — `clientLeft`/`clientWidth` exclude its border
    // and any scrollbar gutter, which its bounding rect includes.
    const scrollerRect = scroller.getBoundingClientRect();
    const visibleLeft = scrollerRect.left + scroller.clientLeft;
    const visibleRight = visibleLeft + scroller.clientWidth;
    return {
      cellClearsLeftEdge: rect.left >= visibleLeft - 1,
      cellClearsRightEdge: rect.right <= visibleRight + 1,
      cellWithinWindow:
        rect.left >= -1 && rect.right <= globalThis.innerWidth + 1,
      foundScroller: true,
      restingScrollLeft: scroller.scrollLeft,
      textOverflows,
    };
  });
}

/**
 * The label/value geometry of every card in the summary strip.
 *
 * `labelLineCount` counts the label's real line boxes through a DOM `Range`,
 * because the ISS-4787 reservation gives a one-line and a two-line label the same
 * region HEIGHT — only the line boxes tell them apart.
 *
 * It ranges over the label's TEXT NODES ONLY. The label region is a flex row of
 * the text plus the `MetricCard` info button, and that button's own box rounds to
 * a different top than the first text line — so ranging over the whole element
 * reported TWO line boxes for a label that had not wrapped at all, which made the
 * wrap guard in the test body pass on every card.
 *
 * It walks DESCENDANT text nodes, not direct children: since the ISS-5070 nowrap
 * island, `MetricCard` nests the label inside two `display: contents` spans, and
 * `contents` preserves the BOX tree, not the NODE tree — a direct-children scan
 * finds no text node at all and reports zero lines for every card.
 */
async function readStripMeasurements(
  strip: Locator
): Promise<CardMeasurement[]> {
  return await strip.locator(CARD_SELECTOR).evaluateAll(
    (cards, input): CardMeasurement[] => {
      const countLineBoxes = (node: HTMLElement): number => {
        const lineTops = new Set<number>();
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
          acceptNode: (textNode) => {
            if (!textNode.nodeValue?.trim()) {
              return NodeFilter.FILTER_REJECT;
            }
            const trigger = textNode.parentElement?.closest("button");
            return trigger && node.contains(trigger)
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT;
          },
        });
        for (
          let textNode = walker.nextNode();
          textNode;
          textNode = walker.nextNode()
        ) {
          const range = document.createRange();
          range.selectNodeContents(textNode);
          for (const rect of Array.from(range.getClientRects())) {
            if (rect.height > 0) {
              lineTops.add(Math.round(rect.top));
            }
          }
        }
        return lineTops.size;
      };

      return cards.map((card) => {
        const label = card.querySelector<HTMLElement>(input.labelSelector);
        const value = card.querySelector<HTMLElement>(input.valueSelector);
        return {
          cardTop: card.getBoundingClientRect().top,
          cardWidth: card.getBoundingClientRect().width,
          // The floor the row RESOLVED for this render, read off the same box
          // that consumes it. Absent parses to `NaN`, which fails both the
          // legal-floor check and the width comparison rather than passing.
          cardMinPx: label
            ? Number.parseFloat(
                getComputedStyle(label).getPropertyValue(input.cardMinProperty)
              )
            : Number.NaN,
          labelHeight: label?.getBoundingClientRect().height ?? 0,
          labelLineCount: label ? countLineBoxes(label) : 0,
          // Read off the LABEL, not the strip: the property is published on the
          // row and inherits down, so reading it here also proves it is in scope
          // for the box that consumes it. Absent (the hook never ran) parses to
          // `NaN`, which fails the comparison rather than passing quietly.
          labelMinPx: label
            ? Number.parseFloat(
                getComputedStyle(label).getPropertyValue(input.labelMinProperty)
              )
            : Number.NaN,
          labelText: label?.textContent?.trim() ?? "",
          valueTop: value?.getBoundingClientRect().top ?? null,
        };
      });
    },
    {
      cardMinProperty: SUMMARY_CARD_MIN_PROPERTY,
      labelMinProperty: SUMMARY_CARD_LABEL_MIN_PROPERTY,
      labelSelector: CARD_DESCRIPTION_SELECTOR,
      valueSelector: CARD_TITLE_SELECTOR,
    }
  );
}

/**
 * The value-top spread within each comparable group of strip cards. Cards are
 * ranked by their own top edge first (a strip that wrapped onto several rows is
 * compared row by row, never as one flat set), then split by label-region height
 * — the ISS-4787 floor is a floor, not a clamp, so a label that needs a third
 * line is taller than its peers and is documented to give up the shared baseline.
 * Groups of one contribute no spread.
 */
function measureRankSpreads(
  measured: (CardMeasurement & { valueTop: number })[]
): number[] {
  const groups = new Map<string, number[]>();
  for (const card of measured) {
    const rank = Math.round(card.cardTop / ROW_GROUPING_TOLERANCE_PX);
    const key = `${rank}:${Math.round(card.labelHeight)}`;
    groups.set(key, [...(groups.get(key) ?? []), card.valueTop]);
  }
  return [...groups.values()]
    .filter((tops) => tops.length > 1)
    .map((tops) => Math.max(...tops) - Math.min(...tops));
}

/**
 * The one label-region height the reservation gives EVERY card in the strip: the
 * tallest label region actually rendered in the row (ISS-4887), which at
 * `leading-4` is its highest line count times the line box.
 */
function derivedLabelReservationPx(cards: CardMeasurement[]): number {
  return (
    Math.max(...cards.map((card) => card.labelLineCount)) * LABEL_LINE_HEIGHT_PX
  );
}

/** The paired ARIA facts the shared GridTable emits on the real desktop route. */
async function readGridSemantics(
  table: Locator,
  costColumnId: string
): Promise<GridSemantics> {
  return await table.evaluate((node, columnId): GridSemantics => {
    const columnHeaders = [
      ...node.querySelectorAll<HTMLElement>('[role="columnheader"]'),
    ];
    const cells = [...node.querySelectorAll<HTMLElement>('[role="cell"]')];
    const colcount = Number(node.getAttribute("aria-colcount"));
    // By column id, not by header text: a reorderable header also contains its
    // drag handle's label, so a text match would find no header at all and the
    // pairing check below would report a false negative.
    const costHeaderIndex =
      columnHeaders
        .find((header) => header.dataset.columnId === columnId)
        ?.getAttribute("aria-colindex") ?? null;

    return {
      colcountMatchesHeaderCount: colcount === columnHeaders.length,
      // The pairing that makes the semantics useful: a body cell announces the
      // same track number its header does.
      costCellsMatchHeaderIndex:
        costHeaderIndex !== null &&
        cells.some(
          (cell) => cell.getAttribute("aria-colindex") === costHeaderIndex
        ),
      everyCellHasColindex: cells.every((cell) =>
        cell.hasAttribute("aria-colindex")
      ),
      // Every cell must live inside a row — an orphan `cell` is itself an ARIA
      // violation.
      everyCellIsInsideARow: cells.every(
        (cell) => cell.closest('[role="row"]') !== null
      ),
      everyHeaderHasColindex: columnHeaders.every((header) =>
        header.hasAttribute("aria-colindex")
      ),
      // ISS-4672 promoted these to real columnheaders, so a label-less column
      // (the row-actions track) must still name itself rather than announce blank.
      everyHeaderIsNamed: columnHeaders.every(
        (header) =>
          (header.getAttribute("aria-label") ?? header.textContent ?? "").trim()
            .length > 0
      ),
      sortableHeadersDeclareSort: columnHeaders.some((header) =>
        header.hasAttribute("aria-sort")
      ),
    };
  }, costColumnId);
}

/**
 * The Cost cell's AT-REST facts: the grid has not auto-scrolled, and the cell
 * already holds its whole value undivided wherever it sits.
 *
 * Projected rather than asserted whole, because ISS-5315 moved Cost past the
 * horizontal fold — `cellClearsRightEdge` / `cellWithinWindow` describe the
 * column's fold-relative POSITION at rest, not its legibility, and pinning them
 * here would re-pin the ISS-4788 ordering that ISS-5315 deliberately replaced.
 * They are asserted in {@link readCostCellOnScreen} instead, where they are the
 * contract.
 */
async function readCostCellAtRest(costCell: Locator): Promise<{
  cellClearsLeftEdge: boolean;
  foundScroller: boolean;
  restingScrollLeft: number | null;
  textOverflows: boolean;
}> {
  const layout = await readCostCellLayout(costCell);
  return {
    cellClearsLeftEdge: layout.cellClearsLeftEdge,
    foundScroller: layout.foundScroller,
    restingScrollLeft: layout.restingScrollLeft,
    textOverflows: layout.textOverflows,
  };
}

/**
 * The Cost cell's facts once ISS-4901's scroll affordance has brought it in: it
 * sits wholly inside both the scroller and the window, still undivided.
 *
 * `restingScrollLeft` is dropped here for the obvious reason — the cell was just
 * scrolled to, so the scroller is no longer at rest and the number it reports is
 * a layout detail, not a contract.
 */
async function readCostCellOnScreen(costCell: Locator): Promise<{
  cellClearsLeftEdge: boolean;
  cellClearsRightEdge: boolean;
  cellWithinWindow: boolean;
  foundScroller: boolean;
  textOverflows: boolean;
}> {
  const layout = await readCostCellLayout(costCell);
  return {
    cellClearsLeftEdge: layout.cellClearsLeftEdge,
    cellClearsRightEdge: layout.cellClearsRightEdge,
    cellWithinWindow: layout.cellWithinWindow,
    foundScroller: layout.foundScroller,
    textOverflows: layout.textOverflows,
  };
}

/** The Cost cell holding a given figure, anchored on the stable per-track id. */
function costCellForText(page: Page, text: string): Locator {
  return page
    .locator(`[role="cell"][data-column-id="${COST_COLUMN_ID}"]`)
    .locator("visible=true")
    .filter({ hasText: text })
    .first();
}

/**
 * The COMPUTED type treatment of a Cost figure — the half jsdom cannot see.
 *
 * `fontVariantNumeric` is what actually lines the decimal points up, and
 * `textOverflow` is the ISS-4891 no-ellipsis contract: `clip` on correct code,
 * `ellipsis` the moment a `truncate` comes back. Read off the cost element
 * itself (not the grid cell) so a wrapper's defaults cannot answer for it. The
 * web twin reads the same two properties.
 */
function readCostTextTreatment(costCell: Locator): Promise<{
  fontVariantNumericHasTabularNums: boolean;
  textOverflow: string;
}> {
  return costCell
    .locator(`[data-testid="${COST_CELL_TEST_ID}"]`)
    .evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        fontVariantNumericHasTabularNums:
          style.fontVariantNumeric.includes("tabular-nums"),
        textOverflow: style.textOverflow,
      };
    });
}

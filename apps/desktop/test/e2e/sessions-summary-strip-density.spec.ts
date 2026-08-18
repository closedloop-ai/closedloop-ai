/**
 * E2E regression: the five Sessions summary cards form ONE rank at the desktop
 * launch width, and the label reservation ISS-4787 bought still holds at the
 * tighter interior that makes that possible (ISS-5068, desktop).
 *
 * The strip lays out on `repeat(auto-fit, minmax(var(--summary-card-min), 1fr))`
 * with a 16px gap (`SummaryCardRow`). As shipped the floor is 260px, so five
 * cards on one rank need `5 * 260 + 4 * 16 = 1364px` of track. The window opens
 * at `DEFAULT_WINDOW_WIDTH`, and beside the 16rem rail and the page padding the
 * Sessions strip measures well under that: at the 1400px default the track is
 * ~1,099px, so it fits four cards and misses five. (It was ~1,079px at the
 * previous 1380px default and missed five there too. Widening the window did not
 * close the wrap, which is why this spec survived the widening unchanged.
 * Whether a strip at the ROOMY floor then lays those four across or steps back
 * to three is ISS-4966's `summary-strip-column-cardinality` derivation, not this
 * spec's business.)
 *
 * The fix does NOT simply lower the floor. Below 260px the longest label the
 * strip shipped when ISS-5068 was written, "Non-subscription Cost", took a THIRD
 * line, overshot the two-line region ISS-4787 reserved, and dropped that card's
 * value off the shared baseline. That is the regression
 * `sessions-summary-strip-baseline.spec.ts` guards. (That label has since been
 * shortened to "cost" and no label the strip ships wraps at this width any more,
 * so the reservation the row derives is one line rather than two — the guard
 * below is written against the two-line CEILING, which is the invariant, not
 * against whatever the current copy happens to measure.) So the density pays for
 * the lower floor on the INSIDE of the card: a
 * tighter interior (`px-4`/`py-4`/`gap-3` in place of the `Card` primitive's
 * `px-6`/`py-6`/`gap-6`) returns 16px of label width at any card width, and the
 * reservation still holds. This spec asserts BOTH halves, so a future shrink of
 * the floor without the interior fails here.
 *
 * The renderer unit suites can only pin the emitted class strings; jsdom has no
 * layout engine, so nothing there can see a card's real width or its real top.
 * This drives the built Electron app at its actual launch width and measures
 * them, which is the only place the wrap is visible.
 *
 * ONE unconditional pass, since ISS-5366 retired the `summary-strip-density`
 * Labs toggle and the compact strip is simply what ships. This spec used to run
 * BOTH sides of that gate, and leaned on the gate-OFF pass — which reproduced
 * the defect verbatim, more than one rank — to prove the gate-ON "exactly one
 * rank" assertion was a real measurement rather than a locator that never
 * matched anything. With no second state left to compare against, that proof is
 * carried by two guards on the single path instead, and neither is optional:
 *
 *  - the CARD COUNT is asserted to be exactly `EXPECTED_CARD_COUNT` before any
 *    per-card check, so "one rank" can never be satisfied by an empty or
 *    half-built strip. A locator that matched nothing fails here first.
 *  - the measured floor is asserted to be BOTH above zero and strictly below the
 *    shipped 260px `SHIPPED_CARD_MIN_WIDTH_PX`. This is what the gate-OFF pass
 *    used to establish: a strip that happened to close one rank at the ROOMY
 *    floor would satisfy the rank assertion while the density did nothing, and
 *    it is rejected here on the floor rather than on the rank.
 *
 * So the single pass still fails in both directions the regression can return
 * from — the rank re-wrapping, and the rank being closed by something other than
 * the compact floor.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
} from "../../src/shared/window-defaults.js";
import { launchDesktopApp } from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";
import {
  BASELINE_TOLERANCE_PX,
  describeRanks,
  EXPECTED_CARD_COUNT,
  expectCardsAtOrAboveFloor,
  expectFreshWindowBounds,
  expectLabelsWithinReservation,
  LABEL_LINE_HEIGHT_PX,
  measureRankSpreads,
  measureRankTops,
  measureSettledStrip,
  openSeededSessionsList,
  RESERVED_LABEL_MAX_LINES,
  type StripMeasurement,
} from "./helpers/summary-strip";

/**
 * The REAL launch geometry, imported rather than re-declared. The wrap this spec
 * exists to catch is a function of the width the window actually opens at, so a
 * local literal would keep passing after someone changed the default and stopped
 * measuring the regime users see. `src/shared/window-defaults.ts` is a leaf with
 * no imports at all, which is why it is safe to pull into a spec (see the flag
 * note below).
 *
 * Asserting the REAL bounds also puts a requirement on the runner: Electron
 * clamps a fresh window to the display, and `xvfb-run -a` alone gives a
 * 1280x1024 screen, so this assertion failed on CI at `width: 1280` while the
 * app was asking for 1400. The `desktop-e2e` job therefore sizes its virtual
 * screen past the default window (`--server-args="-screen 0 …"` in
 * `.github/workflows/e2e-test.yml`), and
 * `scripts/lint/desktop-e2e-display-geometry.test.ts` holds the two together, so
 * the strip below is measured at the width users get rather than at whatever the
 * display was willing to grant.
 *
 * This is the EXPECTED launched geometry, asserted against the real
 * `BrowserWindow` bounds — NOT a viewport this spec sets. #4445 review (wongk):
 * it used to be handed to `page.setViewportSize()`, which overwrote the launched
 * renderer size with a synthetic one built from these same two constants, so
 * both flag paths measured a viewport the spec had just imposed rather than the
 * fresh window. Nothing here resizes the window any more.
 */
const EXPECTED_LAUNCH_BOUNDS = {
  height: DEFAULT_WINDOW_HEIGHT,
  width: DEFAULT_WINDOW_WIDTH,
};

// The Cost card's label, whose wrap point set the per-card floor (ISS-4787) and
// which is still the card to name in a failure: it carries the info trigger
// after the text, so it is the first to need a second line as the interior
// tightens. It is no longer the LONGEST label the strip ships — at this width
// "Total Tokens" is — so nothing here may assume it wraps; the assertions on it
// bound its line count instead of pinning one.
const COST_CARD_LABEL = "cost";

// The roomy floor. The compact floor must come in UNDER it, otherwise the
// density resolved comfortable and the one-rank assertion below would be
// passing for some unrelated reason.
const SHIPPED_CARD_MIN_WIDTH_PX = 260;

const TEST_TIMEOUT_MS = 180_000;

const SEEDED_SESSION_NAME_PREFIX = "ISS-5068 summary strip density";

const SEEDED_SESSIONS: SessionListSeed[] = Array.from(
  { length: 3 },
  (_value, index) => ({
    estimatedCost: 12.5 + index,
    name: `${SEEDED_SESSION_NAME_PREFIX} ${index + 1}`,
    sessionId: `iss-5068-summary-strip-density-${index + 1}`,
  })
);

// Derived from the prefix rather than read back as `SEEDED_SESSIONS[0].name`:
// under `noUncheckedIndexedAccess` that index is `string | undefined`, and
// `getByRole`'s `name` option accepts `undefined` as "match ANY link", so the
// wait for real data would silently degrade into a wait for the first link on
// the page. Same string, no index, no way to lose it.
const FIRST_SEEDED_SESSION_NAME = `${SEEDED_SESSION_NAME_PREFIX} 1`;

test.describe("Sessions summary strip density (ISS-5068)", () => {
  test("lays the five cards on ONE rank at the launch width without reopening ISS-4787", async () => {
    test.setTimeout(TEST_TIMEOUT_MS);

    await withSeededDesktopProfile({ prefix: "iss-5068" }, async (launched) => {
      const measurement = await measureSessionsStrip(launched);

      // Vacuity guard: the whole strip mounted, so every per-card check below
      // is measuring the real rank and not an empty or half-built one.
      expect(measurement.cards).toHaveLength(EXPECTED_CARD_COUNT);

      // The fix itself, asserted FIRST so a regression reports the defect
      // rather than one of its causes. Counting cards would NOT catch it, all
      // five render either way; what changes is how many visual rows they
      // occupy. Distinct measured tops is the only thing that sees the wrap.
      const rankTops = measureRankTops(measurement.cards);
      expect(
        rankTops,
        `expected one rank of ${EXPECTED_CARD_COUNT} cards at ${EXPECTED_LAUNCH_BOUNDS.width}px, got ${describeRanks(measurement.cards)}`
      ).toHaveLength(1);

      // …and it is the COMPACT floor that bought the rank, not something
      // else. A strip that happened to fit on one rank at the roomy floor
      // would satisfy the assertion above while the density did nothing.
      expect(measurement.minCardWidthPx).toBeGreaterThan(0);
      expect(measurement.minCardWidthPx).toBeLessThan(
        SHIPPED_CARD_MIN_WIDTH_PX
      );

      // The lower floor is only honest if the cards are actually laid out at
      // or above it, an auto-fit track that overflowed would report a floor
      // it never respected.
      expectCardsAtOrAboveFloor(measurement);

      // ISS-4787 has NOT been reopened: at the dense interior the Cost card's
      // label still fits INSIDE the two lines the row reserves. Asserted on that
      // card by name as well as across the rank, because it is the one that
      // breaks first and a generic sweep would not say so in the failure.
      //
      // Asserted as a BOUND plus the row's own published reservation, not as an
      // equality against a hardcoded `2 × 16`. ISS-4887 made the reservation
      // DERIVED from the tallest label actually rendered, so its value is a
      // function of the label set: 32px while a label wrapped, 16px once none
      // does. Pinning 32 pinned the copy, not the geometry — it turned any
      // shortening of a label into a red density spec even though the thing this
      // spec guards (no label past two lines, every value on one baseline) still
      // held. What must never happen is a THIRD line, and that is what the bound
      // below states directly.
      const costCard = measurement.cards.find((card) =>
        card.labelText.includes(COST_CARD_LABEL)
      );
      expect(
        costCard,
        `"${COST_CARD_LABEL}" card not found in ${describeRanks(measurement.cards)}`
      ).toBeDefined();
      // A zero line count means the text-node range measured nothing, which
      // would satisfy the ceiling vacuously.
      expect(costCard?.labelLineCount).toBeGreaterThanOrEqual(1);
      expect(costCard?.labelLineCount).toBeLessThanOrEqual(
        RESERVED_LABEL_MAX_LINES
      );
      // Its region must sit EXACTLY on the reservation the ROW published, which
      // is `max(lines) × 16` ACROSS the rank — deliberately not this card's own
      // `lines × 16`. Those two are the same number only while the Cost card is
      // the tallest label; the moment a sibling wraps and it does not, its own
      // line count would understate the region it is correctly being floored to,
      // and pinning to it would fail on a healthy strip. Same trap as the
      // hardcoded 32 this replaced, one level down.
      const derivedReservationPx =
        Math.max(...measurement.cards.map((card) => card.labelLineCount)) *
        LABEL_LINE_HEIGHT_PX;
      expect(costCard?.labelHeight).toBeCloseTo(derivedReservationPx, 0);
      expectLabelsWithinReservation(measurement.cards);

      // …and therefore its value still holds the rank's shared baseline, which
      // is the reading the reservation exists to protect. One rank now, so one
      // spread.
      const spreads = measureRankSpreads(measurement.cards);
      expect(spreads).toHaveLength(1);
      expect(spreads[0]).toBeLessThanOrEqual(BASELINE_TOLERANCE_PX);
    });
  });
});

/**
 * Launch the built app twice against ONE temp profile, once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real Sessions IPC source
 * reads the seeded corpus at boot.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only rows are the seeded ones (mirrors
 * `sessions-summary-strip-baseline.spec.ts`).
 */
async function withSeededDesktopProfile(
  { prefix }: { prefix: string },
  run: (launched: { app: ElectronApplication; page: Page }) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  try {
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

    const { app, page, cleanup } = await launchDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await run({ app, page });
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
}

/**
 * Prove the app opened at the launch geometry, then read the strip that geometry
 * produced once its layout has settled. Both halves live in
 * `helpers/summary-strip` so this spec and `sessions-summary-strip-baseline`
 * measure the same strip the same way.
 *
 * The bounds assertion runs FIRST and no `viewport` is passed, which is the
 * whole point (#4445 review, wongk): the strip is measured at the size the
 * `BrowserWindow` actually launched with, and a window that opened at some other
 * size fails here by name instead of being silently resized into agreement.
 */
async function measureSessionsStrip({
  app,
  page,
}: {
  app: ElectronApplication;
  page: Page;
}): Promise<StripMeasurement> {
  await expectFreshWindowBounds(app, EXPECTED_LAUNCH_BOUNDS);
  await openSeededSessionsList(page, {
    firstSeededName: FIRST_SEEDED_SESSION_NAME,
  });
  return await measureSettledStrip(page);
}

/**
 * E2E regression: no Sessions summary card is laid out under the per-card floor
 * its label reservation assumes, so the strip reads as one aligned rank of
 * numbers (ISS-4787, desktop).
 *
 * ISS-4787 gave the Sessions/Branches summary strips a shared label reservation
 * (`SummaryCardRow` in packages/app/shared/components/summary-card-row.tsx, over
 * a `leading-4` line box) so a label that wraps — "Non-subscription Cost" at the
 * strip's card width — keeps its value on the same baseline as its one-line
 * siblings. ISS-4887 made that reservation DERIVED from the tallest label the
 * row actually renders and published it on `--summary-card-label-min`; ISS-5062
 * retired the gate, so the derived value is the only path. It still holds only
 * while a card is at least `--summary-card-min` (260px) wide.
 *
 * The desktop strip used to pin its columns (`lg:grid-cols-3 xl:grid-cols-5`)
 * instead of deriving them from that floor. Beside the 16rem rail that left each
 * card ~209px at the 1380px window this spec pins, the label took a THIRD line, its
 * region grew to 48px against every sibling's 32px, and its value sat 16px — one
 * whole line box — below the rest of the rank. The web twin, which already
 * derived its columns from the same floor, never wrapped that far.
 *
 * The renderer unit suites can only pin the emitted class strings; jsdom has no
 * layout engine, so nothing there can see a card's real width or a value's real
 * top. This drives the built Electron app at the reported window size and
 * measures both, which is the only place the regression is actually visible.
 *
 * It fails on the pinned-column layout: the Cost card is laid out under the
 * published floor, and its label takes a third line — both asserted directly,
 * since ISS-4887's derived reservation grows to absorb that third line rather
 * than leaving the card 16px taller than its rank.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";
import {
  BASELINE_TOLERANCE_PX,
  EXPECTED_CARD_COUNT,
  expectCardsAtOrAboveFloor,
  expectLabelsWithinReservation,
  measureRankSpreads,
  measureSettledStrip,
  openSeededSessionsList,
} from "./helpers/summary-strip";

// A DELIBERATELY NARROW window, not the launch default — do not swap this for
// `DEFAULT_WINDOW_WIDTH`. 1380 is the width the stagger was reported at, and the
// regime this spec exists to measure; pinning it keeps the measurement in that
// regime whatever display the runner has, and whatever the default is widened
// to next. (The sibling `sessions-summary-strip-density.spec.ts` is the one that
// tracks the launch geometry, and it imports the constants for exactly that
// reason.)
const DESKTOP_VIEWPORT = { height: 900, width: 1380 };

const SEEDED_SESSION_NAME_PREFIX = "ISS-4787 summary strip";

const SEEDED_SESSIONS: SessionListSeed[] = Array.from(
  { length: 3 },
  (_value, index) => ({
    estimatedCost: 12.5 + index,
    name: `${SEEDED_SESSION_NAME_PREFIX} ${index + 1}`,
    sessionId: `iss-4787-summary-strip-${index + 1}`,
  })
);

// Derived from the prefix rather than read back as `SEEDED_SESSIONS[0].name`:
// under `noUncheckedIndexedAccess` that index is `string | undefined`, and
// `getByRole`'s `name` option accepts `undefined` as "match ANY link", so the
// wait for real data would silently degrade into a wait for the first link on
// the page. Same string, no index, no way to lose it.
const FIRST_SEEDED_SESSION_NAME = `${SEEDED_SESSION_NAME_PREFIX} 1`;

test.describe("Sessions summary strip baseline (ISS-4787)", () => {
  test("every card clears the published minimum and shares its rank's value baseline", async () => {
    test.setTimeout(180_000);

    // Empty CLAUDE_HOME/CODEX_HOME so the boot collectors ingest nothing and the
    // only rows are the seeded ones (mirrors sessions-column-fold.spec.ts).
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-summary-strip-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-summary-strip-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-summary-strip-udd-")
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
        await openSeededSessionsList(page, {
          firstSeededName: FIRST_SEEDED_SESSION_NAME,
          viewport: DESKTOP_VIEWPORT,
        });

        // Waits for the strip to mount, for webfont swap-in to settle, and then
        // polls until it reports its full card set, never a fixed delay. All
        // three live in `helpers/summary-strip` so this spec and the ISS-5068
        // density spec measure the same strip the same way.
        const measurement = await measureSettledStrip(page);

        // Vacuity guard: the whole strip mounted, so the per-card checks below
        // are measuring the real rank and not an empty or half-built one.
        expect(measurement.cards).toHaveLength(EXPECTED_CARD_COUNT);
        expect(measurement.minCardWidthPx).toBeGreaterThan(0);

        // The fix itself: the strip derives its columns from the published floor,
        // so no card can be laid out under it at any window width.
        expectCardsAtOrAboveFloor(measurement);

        // …and therefore every label still fits the two lines the floor is sized
        // for, the row published the reservation those labels derive, and every
        // card's region IS it. A card squeezed under the floor takes a third
        // line, which this rejects outright.
        expectLabelsWithinReservation(measurement.cards);

        // The reading the reservation exists to protect: one rank, one baseline.
        // Grouped by visual row first — the strip genuinely wraps, and a flat
        // comparison across rows would be wrong.
        const rankSpreads = measureRankSpreads(measurement.cards);
        expect(rankSpreads.length).toBeGreaterThan(0);
        for (const spread of rankSpreads) {
          expect(spread).toBeLessThanOrEqual(BASELINE_TOLERANCE_PX);
        }
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

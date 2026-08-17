/**
 * Shared measurement harness for the Sessions summary strip E2Es.
 *
 * Two specs drive the SAME strip and assert on the SAME label reservation,
 * `sessions-summary-strip-baseline.spec.ts` (ISS-4787: no card is laid out under
 * the published floor) and `sessions-summary-strip-density.spec.ts` (ISS-5068:
 * the five cards form one rank at the launch width). Before this module they each
 * carried their own copy of the selectors, the tolerances, the measurement
 * `evaluate`, and the rank binning, and the copies had already diverged: one
 * factored the binning into a helper, the other inlined it. AGENTS.md is explicit
 * that a nontrivial test fixture appearing in more than one file belongs in the
 * nearest shared module owned by the surface, and `test/e2e/helpers/` is where
 * this suite already keeps `desktop-app` and `seed-branches-db`.
 *
 * Deliberately electron-free and `@repo/*`-free. A `.tsx` specifier resolves only
 * through the renderer's vite alias and an extension-less `@repo/*` subpath does
 * not resolve under Playwright's ESM loader at all, importing either from a spec
 * aborts the WHOLE desktop-e2e suite at load time, with no failing test name to
 * point at it. Everything here is Playwright plus plain DOM.
 */

import {
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { gotoNav } from "./desktop-app";

/**
 * The strip's five cards (FEA-4126: Sessions, Total Tokens, Cost, PRs Shipped,
 * LOC / $). Asserted by both specs so a strip that failed to mount its cards
 * cannot make the per-card checks pass vacuously.
 */
export const EXPECTED_CARD_COUNT = 5;

/**
 * The `leading-4` (1rem) line box every card's label is pinned to, so a label's
 * NATURAL region height is `lines × 16`.
 *
 * ISS-5062: this used to be a flat `RESERVED_LABEL_HEIGHT_PX = 32` — `min-h-8`,
 * the fixed two-line floor ISS-4787 shipped — and the reservation was asserted
 * as an equality against it. ISS-4887 replaced that floor with one DERIVED from
 * the tallest label actually rendered in the row, and retiring the
 * `summary-strip-label-baseline` gate makes the derived one the only path. So
 * the reservation is still asserted as an equality, but against the row's own
 * `max(lines) × 16` (see {@link expectLabelsWithinReservation}) — 32 when a
 * label wrapped, 16 when none did.
 */
export const LABEL_LINE_HEIGHT_PX = 16;

/**
 * The two lines the strip's per-card floor is SIZED to hold: the longest label
 * either strip ships takes exactly two at that floor (ISS-4787). A third means
 * the cards came out narrower than the floor assumes.
 */
export const RESERVED_LABEL_MAX_LINES = 2;

/**
 * Sub-pixel rounding on a measured box, and on a track width divided out of a
 * fractional container. Well under a line box or a glyph.
 */
export const MEASUREMENT_TOLERANCE_PX = 1.5;

/**
 * Values in one rank share a baseline; a couple of pixels of rounding do not
 * break the reading, a 16px line box does.
 */
export const BASELINE_TOLERANCE_PX = 2;

/**
 * Cards in a wrapped grid sit on several visual rows, and only cards in the SAME
 * row share a baseline. Bin by measured top before counting ranks or comparing
 * value offsets.
 */
export const ROW_GROUPING_TOLERANCE_PX = 4;

export const MOUNT_TIMEOUT_MS = 30_000;

/**
 * The summary strip publishes its per-card floor as an inline custom property
 * (`SummaryCardRow`), which makes the style attribute a structural handle on the
 * strip itself, no class name, and no `@repo/app` import (see the module note
 * above).
 */
export const STRIP_SELECTOR = '[style*="--summary-card-min"]';

/**
 * `SUMMARY_CARD_LABEL_MIN_PROPERTY` (packages/app/shared/hooks/
 * use-summary-label-baseline.ts): the property the row publishes its DERIVED
 * label reservation on, and the one the label class floors to. Pinned as a
 * literal for the same reason everything else here is (see the module note).
 * Reading it is what keeps {@link expectLabelsWithinReservation} non-vacuous in
 * a strip where every label is one line: the class's CSS fallback is the retired
 * fixed `2rem`, so a row that stopped deriving reports 32 where it reports 16.
 */
export const SUMMARY_CARD_LABEL_MIN_PROPERTY = "--summary-card-label-min";
export const CARD_SELECTOR = '[data-slot="card"]';
export const CARD_TITLE_SELECTOR = '[data-slot="card-title"]';
export const CARD_DESCRIPTION_SELECTOR = '[data-slot="card-description"]';

/** One summary card's measured geometry. */
export type CardMeasurement = {
  cardTop: number;
  cardWidth: number;
  labelHeight: number;
  /**
   * Line boxes the label's OWN TEXT occupies — the input the row's derived
   * reservation takes its maximum over. Counted over text nodes only, because
   * `MetricCard` composes an info-popover button into the same slot whose box
   * rounds to a different top and would report a phantom second line.
   */
  labelLineCount: number;
  /**
   * The reservation the ROW published on
   * {@link SUMMARY_CARD_LABEL_MIN_PROPERTY}, as the card sees it. `NaN` when
   * nothing was published, so the comparison fails loudly instead of degrading
   * to the class's CSS fallback unnoticed.
   */
  labelMinPx: number;
  labelText: string;
  valueTop: number;
};

/** What the rendered strip says about the floor it laid its cards out against. */
export type StripMeasurement = {
  cards: CardMeasurement[];
  /** The published `--summary-card-min`, in px. */
  minCardWidthPx: number;
};

/**
 * Open the Sessions list with the seeded rows in range, and wait for a seeded
 * row so the strip is measured against real data rather than its skeleton.
 *
 * `viewport` is OPTIONAL, and the two specs use the two halves on purpose.
 *
 *  - PASSED (`sessions-summary-strip-baseline.spec.ts`): resize to a pinned
 *    regime. That spec measures the label stagger at the width it was reported
 *    at, which is deliberately not the launch geometry, so a synthetic viewport
 *    is exactly what it wants.
 *  - OMITTED (`sessions-summary-strip-density.spec.ts`): leave the renderer at
 *    the size the `BrowserWindow` actually launched with. #4445 review (wongk):
 *    calling `setViewportSize(DEFAULT_*)` here replaced the launched renderer
 *    size with a SYNTHETIC viewport that merely happened to equal the constants,
 *    so the spec passed whatever geometry the window really opened at — it was
 *    re-measuring its own input. A spec about the fresh window must not resize
 *    it; assert the launched bounds instead (see
 *    {@link expectFreshWindowBounds}).
 */
export async function openSeededSessionsList(
  page: Page,
  {
    firstSeededName,
    viewport,
  }: {
    firstSeededName: string;
    viewport?: { height: number; width: number };
  }
): Promise<void> {
  if (viewport) {
    await page.setViewportSize(viewport);
  }
  await gotoNav(page, "sessions");
  // Widen the window filter so the rows are in range independent of the run
  // clock. `:visible` scopes to the Sessions toolbar (keep-alive views stay
  // mounted-but-hidden and render the same control).
  await page.locator('[aria-label="All time"]:visible').click();
  await expect(page.getByRole("link", { name: firstSeededName })).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
}

/**
 * The visible summary strip, settled enough to measure: mounted, past webfont
 * swap-in, and reporting its full card set.
 *
 * Where a label breaks depends on the metrics of the font actually in use, so
 * `document.fonts.ready` is awaited first, the browser's own settled signal, a
 * stable state rather than a guessed delay.
 */
export async function measureSettledStrip(
  page: Page
): Promise<StripMeasurement> {
  const strip = page.locator(STRIP_SELECTOR).locator("visible=true").first();
  await expect(strip).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  return await pollSettledStrip(strip);
}

/**
 * Re-read the strip until it reports its full card set, so the assertions run
 * against a settled layout rather than a partially hydrated first frame. Polled,
 * never a fixed delay: the cards hydrate their values after the first paint.
 */
export async function pollSettledStrip(
  strip: Locator
): Promise<StripMeasurement> {
  let settled: StripMeasurement | null = null;
  await expect
    .poll(
      async () => {
        settled = await readStripMeasurement(strip);
        return settled.cards.length;
      },
      { timeout: MOUNT_TIMEOUT_MS }
    )
    .toBe(EXPECTED_CARD_COUNT);
  if (!settled) {
    throw new Error("Sessions summary strip never reported a measurement");
  }
  return settled;
}

/** The strip's published floor plus the geometry of every card inside it. */
export function readStripMeasurement(
  strip: Locator
): Promise<StripMeasurement> {
  return strip.evaluate(
    (node, selectors): StripMeasurement => {
      // Count the label's real LINE BOXES through a DOM `Range` over its TEXT
      // NODES ONLY. `CardDescription` is a flex row of the label text plus
      // `MetricCard`'s info-popover button, and that button's box rounds to a
      // different top — `selectNodeContents` on the whole element reports TWO
      // line boxes for a label that never wrapped.
      //
      // The text is a DESCENDANT, not necessarily a direct child. Since the
      // ISS-5070 nowrap island, `MetricCard` nests the label inside two
      // `display: contents` spans (an outer `whitespace-nowrap` join holding
      // label + trigger, an inner `whitespace-normal` span over the text).
      // `contents` preserves the BOX tree, not the NODE tree — so a direct
      // `childNodes` scan found no text node at all and EVERY card reported
      // zero lines. Walking descendants measures the same line boxes a reader
      // sees, at any nesting depth. The web twin
      // (`e2e/sessions-table-legibility.spec.ts`) carries the same fix.
      const countLineBoxes = (label: HTMLElement): number => {
        const lineTops = new Set<number>();
        const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT, {
          acceptNode: (textNode) => {
            // Whitespace between elements is not label text; it can still
            // report a rect and would invent a line.
            if (!textNode.nodeValue?.trim()) {
              return NodeFilter.FILTER_REJECT;
            }
            // Text inside the info trigger belongs to the button's own box,
            // which rounds to a different top than line one — the exclusion
            // this helper has always made, now expressed against the subtree.
            const trigger = textNode.parentElement?.closest("button");
            return trigger && label.contains(trigger)
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
      const rawMin = getComputedStyle(node)
        .getPropertyValue("--summary-card-min")
        .trim();
      const cards = Array.from(
        node.querySelectorAll<HTMLElement>(selectors.card)
      ).flatMap((card): CardMeasurement[] => {
        const label = card.querySelector<HTMLElement>(selectors.description);
        const value = card.querySelector<HTMLElement>(selectors.title);
        // A skeletoned card carries neither slot; it is not yet a measurable
        // member of the rank, so it drops out rather than reporting a zero.
        if (!(label && value)) {
          return [];
        }
        const cardRect = card.getBoundingClientRect();
        return [
          {
            cardTop: cardRect.top,
            cardWidth: cardRect.width,
            labelHeight: label.getBoundingClientRect().height,
            labelLineCount: countLineBoxes(label),
            // Read off the LABEL, not the strip: the property inherits down, so
            // reading it here also proves it is in scope for the box that
            // consumes it. Absent (the hook never ran) parses to `NaN`, which
            // fails the comparison rather than passing quietly.
            labelMinPx: Number.parseFloat(
              getComputedStyle(label).getPropertyValue(
                selectors.labelMinProperty
              )
            ),
            labelText: label.textContent?.trim() ?? "",
            valueTop: value.getBoundingClientRect().top,
          },
        ];
      });
      return { cards, minCardWidthPx: Number.parseFloat(rawMin) };
    },
    {
      card: CARD_SELECTOR,
      description: CARD_DESCRIPTION_SELECTOR,
      labelMinProperty: SUMMARY_CARD_LABEL_MIN_PROPERTY,
      title: CARD_TITLE_SELECTOR,
    }
  );
}

/**
 * Bin the cards by their own measured top edge. One bucket per visual row, so the
 * bucket COUNT is the number of ranks the strip wrapped into, the single
 * measurement that distinguishes a one-rank strip from a wrapped one.
 */
export function groupCardsByRank(
  cards: CardMeasurement[]
): Map<number, CardMeasurement[]> {
  const ranks = new Map<number, CardMeasurement[]>();
  for (const card of cards) {
    const bucket = Math.round(card.cardTop / ROW_GROUPING_TOLERANCE_PX);
    const members = ranks.get(bucket) ?? [];
    members.push(card);
    ranks.set(bucket, members);
  }
  return ranks;
}

/** The distinct card-top buckets the strip laid out into, lowest first. */
export function measureRankTops(cards: CardMeasurement[]): number[] {
  return Array.from(groupCardsByRank(cards).keys()).sort((a, b) => a - b);
}

/**
 * The spread of value tops within each visual row. Only cards in the same row are
 * supposed to share a baseline, so grouping comes first.
 */
export function measureRankSpreads(cards: CardMeasurement[]): number[] {
  return Array.from(groupCardsByRank(cards).values()).map((members) => {
    const valueTops = members.map((card) => card.valueTop);
    return Math.max(...valueTops) - Math.min(...valueTops);
  });
}

/**
 * Every card's label region is the ONE height the row reserves — the tallest
 * label actually rendered in it (ISS-4787's shared baseline, derived since
 * ISS-4887 and un-gated by ISS-5062).
 *
 * Asserted in TWO halves, because since ISS-5062 either alone can pass on
 * nothing. The row must have PUBLISHED the derived reservation (which separates
 * it from the class's retired fixed `2rem` CSS fallback — otherwise, in a rank
 * where every label is one line, `max(lines) × 16` is each card's own natural
 * height and the per-card half holds with the reservation deleted), and every
 * card's region must actually BE that published value (a card that missed it
 * collapses to its natural height and takes its value off the rank's baseline,
 * which is the defect this pins). No label may exceed the two lines the floor is
 * sized for — a third is the ISS-4787 width signal, which the derived
 * reservation absorbs silently.
 */
export function expectLabelsWithinReservation(cards: CardMeasurement[]): void {
  // Vacuity guard: a rank needs siblings to share a reservation, and
  // `Math.max()` over nothing is `-Infinity`.
  expect(cards.length).toBeGreaterThan(1);
  // A zero line count means the text-node range found nothing, which would make
  // the derived reservation below `0 × 16` for every card.
  expect(
    cards
      .filter((card) => card.labelLineCount < 1)
      .map((card) => card.labelText)
  ).toEqual([]);
  expect(
    cards
      .filter((card) => card.labelLineCount > RESERVED_LABEL_MAX_LINES)
      .map((card) => `${card.labelText}: ${card.labelLineCount} line(s)`)
  ).toEqual([]);
  const reservedHeightPx =
    Math.max(...cards.map((card) => card.labelLineCount)) *
    LABEL_LINE_HEIGHT_PX;
  const unpublishedReservations = cards
    .filter(
      (card) =>
        !(
          Math.abs(card.labelMinPx - reservedHeightPx) <=
          MEASUREMENT_TOLERANCE_PX
        )
    )
    .map(
      (card) =>
        `${card.labelText}: published ${card.labelMinPx}px for a derived ${reservedHeightPx}px`
    );
  expect(unpublishedReservations).toEqual([]);
  // Compared against the PUBLISHED value rather than the computed one so the
  // hook's `Math.ceil` cannot flake this on a fractional line box.
  const offReservationLabels = cards
    .filter(
      (card) =>
        Math.abs(card.labelHeight - card.labelMinPx) > MEASUREMENT_TOLERANCE_PX
    )
    .map(
      (card) =>
        `${card.labelText}: ${card.labelHeight}px against a ${card.labelMinPx}px reservation for ${card.labelLineCount} line(s)`
    );
  expect(offReservationLabels).toEqual([]);
}

/** Every card is laid out at or above the floor the strip published. */
export function expectCardsAtOrAboveFloor(measurement: StripMeasurement): void {
  const undersizedCards = measurement.cards
    .filter(
      (card) =>
        card.cardWidth < measurement.minCardWidthPx - MEASUREMENT_TOLERANCE_PX
    )
    .map((card) => `${card.labelText}: ${card.cardWidth}px`);
  expect(undersizedCards).toEqual([]);
}

/** A readable rank-by-rank summary for a failure message. */
export function describeRanks(cards: CardMeasurement[]): string {
  const ranks = Array.from(groupCardsByRank(cards).entries()).sort(
    ([a], [b]) => a - b
  );
  return ranks
    .map(
      ([, members], index) =>
        `rank ${index + 1} (${members.length}): ${members
          .map(
            (card) =>
              `${card.labelText} @${Math.round(card.cardWidth)}x${Math.round(card.labelHeight)}px`
          )
          .join(", ")}`
    )
    .join(" | ");
}

/**
 * Assert the window the app ACTUALLY launched with, read from the main process
 * before anything resizes it.
 *
 * #4445 review (wongk): the density spec claimed to measure "the fresh-window
 * geometry" while {@link openSeededSessionsList} was calling
 * `page.setViewportSize(DEFAULT_*)` on it first. That replaced the launched
 * renderer size with a synthetic viewport built from the same two constants the
 * spec was trying to verify, so the assertion was circular — the real
 * `BrowserWindow` could have opened at any size and both flag paths would still
 * have measured 1400x800. Reading `getBounds()` out of the main process is the
 * only place the launched geometry is observable, and it is the OUTER window
 * size, which is exactly what `new BrowserWindow({ width, height })` is given in
 * `src/main/window.ts` (no `useContentSize`).
 */
export async function expectFreshWindowBounds(
  app: ElectronApplication,
  expected: { height: number; width: number }
): Promise<void> {
  const launched = await app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) {
      return null;
    }
    const { height, width } = window.getBounds();
    return { height, width };
  });
  expect(
    launched,
    "no BrowserWindow was open to read the launch geometry from"
  ).not.toBeNull();
  expect(
    launched,
    "the app did not open at DEFAULT_WINDOW_WIDTH x DEFAULT_WINDOW_HEIGHT"
  ).toEqual(expected);
}

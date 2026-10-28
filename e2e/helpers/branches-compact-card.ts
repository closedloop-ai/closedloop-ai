import type { Locator, Page } from "@playwright/test";

/**
 * Reading a Branches row at a width where the list renders CARDS, not a grid.
 *
 * ISS-10301 made the v2 listing the only listing, and `GridTableListSurface`
 * swaps to `BranchCard` below `CARD_FALLBACK_BREAKPOINT` (768px of MEASURED
 * container width, `@repo/design-system/lib/column-order`). Below it there is no
 * `role="grid"`, no `role="row"`, no `role="gridcell"` and no `data-column-id`
 * anywhere on the list — a spec that addresses a narrow Branches row the way it
 * addresses a desktop one resolves zero elements, which is how four specs went
 * red the first time the v1 arm stopped rendering.
 *
 * The card's shape is fixed by `BranchCard` (`branches-grid-v2.tsx`) and
 * `GridTableV2Card`: the lead branch link and the Status cell go in the card
 * HEADER, and every other visible column becomes one `dt`/`dd` pair in a
 * definition list. `preserveEmptyFields` is set, so a column with no value still
 * renders its pair rather than vanishing — which is what lets a spec assert the
 * full field set rather than whatever the fixture happened to populate.
 */
export const BRANCHES_CARD_SELECTOR = '[data-slot="card"]';

/** The card whose header carries the lead link to `branchHref`. */
export function branchCardFor(page: Page, branchHref: string): Locator {
  return page
    .locator(BRANCHES_CARD_SELECTOR)
    .filter({ has: page.locator(`a[href="${branchHref}"]`) })
    .first();
}

/**
 * The `dd` paired with the `dt` whose text is exactly `term`.
 *
 * Exact, because the Branches field labels are prefixes of one another
 * ("Linked sessions" / "Linked issues") and a substring term would pair a value
 * with the wrong label without failing.
 */
export function branchCardFieldValue(card: Locator, term: string): Locator {
  return card
    .locator("dl > div")
    .filter({ has: card.page().getByRole("term").filter({ hasText: term }) })
    .getByRole("definition");
}

/** Every field label the card renders, in rendered order. */
export function branchCardFieldTerms(card: Locator): Locator {
  return card.getByRole("term");
}

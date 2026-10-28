/**
 * ISS-10314: the shared "a v2 list row link is reachable and activatable at
 * 390px" check, and the floor it holds the scroll band to.
 *
 * It exists because the check is a claim about GEOMETRY, and specs asserting a
 * geometry floor with private copies of the number is how they come to disagree
 * about what "usable" means. `e2e/sessions-v2-filters.spec.ts` pinned the
 * Sessions half first; `e2e/list-surface-row-link-390px.spec.ts` pins the
 * Branches half, which had no web witness at all; and
 * `apps/desktop/test/e2e/responsive-pages.spec.ts` pins both on the Electron
 * shell. All three call this.
 *
 * It imports nothing but `@playwright/test`, which is what lets the desktop
 * runner take it by relative path the way its siblings already take
 * `critical-wcag-aa` and `sessions-list-fixtures`. The React-runtime constraint
 * `apps/desktop/test/e2e/helpers/seeded-sessions-v2-list.ts` documents is about
 * `GRID_TABLE_SCROLL_BAND_TEST_ID` living in a component module, not about this
 * file — so that spec passes its test ids in as literals and shares the check.
 */

import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The width root `AGENTS.md` requires to work. Shared with
 * `apps/desktop/test/e2e/responsive-pages.spec.ts` so a regression cannot pass
 * on one shell's width and fail on the other's.
 */
export const NARROW_VIEWPORT_390 = { height: 760, width: 390 } as const;

/**
 * The floor the scroll band must clear: the sticky column header plus one usable
 * row.
 *
 * Deliberately not `> 0`. A 4px band satisfies that and is still not a surface a
 * reader can click a row in, and the defect this guards produces a band that is
 * short rather than absent.
 */
export const MIN_USABLE_SCROLL_BAND_PX = 96;

/**
 * Prove a row link is REACHABLE and ACTIVATABLE, not merely present.
 *
 * Both assertions are load-bearing and neither substitutes for the other.
 *
 * The band assertion is the only thing that can witness starvation.
 * `GridTableListSurface` lays four bands out as a flex column in which the table
 * scroll band is `flex-1` (`flex: 1 1 0%`), so its scaled flex-shrink factor is
 * ZERO — it is the one child that cannot absorb negative free space, while the
 * toolbar, metric and pagination bands are floored at their min-content height.
 * Once those three fill the column the scroller resolves to 0px with its rows
 * still in the DOM, and a link inside a zero-height `overflow: auto` scroller is
 * still `visible` to Playwright. So no assertion about the LINK sees it; only its
 * container does.
 *
 * The real pointer click is what proves the link is not merely inside a tall
 * enough band but actually hit-testable. A programmatic `element.click()`
 * bypasses hit-testing entirely and navigates happily through the clipping this
 * check exists to catch, which is why no fallback of that shape belongs here.
 *
 * `rowLink` must already resolve to ONE element — this deliberately does not
 * call `.first()`, so a locator that matches several stays a loud strict-mode
 * violation instead of silently testing whichever copy came first. It may be
 * anchored anywhere; the band is found by {@link scrollBandHolding}, which walks
 * up from the row rather than re-rooting the row under a band.
 */
export async function clickRowLinkInScrollBand(
  rowLink: Locator,
  scrollBandTestId: string
): Promise<void> {
  await expect(rowLink).toBeVisible({ timeout: 30_000 });
  const band = scrollBandHolding(rowLink, scrollBandTestId);
  await expect
    .poll(() => band.evaluate((element) => element.clientHeight), {
      message: `${scrollBandTestId} should leave a clickable row at 390px`,
    })
    .toBeGreaterThanOrEqual(MIN_USABLE_SCROLL_BAND_PX);
  await rowLink.click();
}

/**
 * No document-level horizontal scroll. Polled rather than read once because the
 * surface measures its own content box and can settle a frame late.
 */
export async function expectNoHorizontalOverflow(
  page: Page,
  surfaceName: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const maxScrollWidth = Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth
          );
          return maxScrollWidth - document.documentElement.clientWidth;
        }),
      { message: `${surfaceName} should not overflow horizontally` }
    )
    .toBeLessThanOrEqual(1);
}

/**
 * The band holding THIS row, found by walking UP from the row.
 *
 * Deliberately not `page.getByTestId(id).filter({ has: rowLink })`: a `has:`
 * locator is re-rooted at the element being filtered, so it only works while the
 * caller's row locator happens to be re-rootable. Pass one anchored somewhere
 * else — `activeNavPanel(...).getByRole(...)`, as the desktop spec must, since
 * keep-alive leaves several bands carrying the same test id — and the filter
 * looks for that anchor BENEATH the band, matches nothing, and the check dies on
 * a timeout that reads exactly like a starved band. The ancestor walk cannot
 * lie that way: it is the band this row is actually in, or there is none.
 */
function scrollBandHolding(
  rowLink: Locator,
  scrollBandTestId: string
): Locator {
  return rowLink.locator(
    `xpath=ancestor::*[@data-testid='${scrollBandTestId}'][1]`
  );
}

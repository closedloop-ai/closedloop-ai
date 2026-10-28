/**
 * The v1 `SessionsSummaryBand` wrapper, as a selector.
 *
 * `sticky left-0` is the band's own pin (`sessions-summary-band.tsx`), but on
 * its own it is a utility pair the v2 grid ALSO wears once a lead column is
 * pinned — ISS-9659 made that unconditional, and the grid's header and body
 * cells then satisfied a bare `.sticky.left-0` query. The role exclusions
 * restore what the selector always meant: the band is a plain wrapper `div`,
 * never a grid cell. The v2 band is found by its own test id instead, so only
 * this half needs a selector at all.
 *
 * A LEAF module on purpose. Its two consumers are whole-view suites with their
 * own `vi.mock` graphs, and hanging this constant off the shared render fixture
 * pulled `SessionsView`'s runtime into one of them and broke its mocks.
 */
export const V1_SUMMARY_BAND_SELECTOR =
  '.sticky.left-0:not([role="columnheader"]):not([role="gridcell"])';

/**
 * Handle for the positioned popup layer (ISS-8777). The layer carries the
 * geometry that keeps the popup out of a scrolling ancestor's clip, and that
 * geometry is a contract a regression test has to be able to read back — an
 * assertion on the listbox alone cannot see which box positions it.
 *
 * Its own module rather than an export of `search-typeahead.tsx` because the
 * web Playwright spec that reads the layer's rendered geometry imports it, and
 * a spec must not pull a React component tree — the design system, the icon
 * set, the navigation package — into the Playwright process to learn a string.
 */
export const SEARCH_POPUP_TEST_ID = "search-popup-layer";

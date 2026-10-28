/**
 * ISS-6382: what a read looks like to a surface while the ISS-4655 restore gate
 * (`isViewReady`) holds it closed.
 *
 * `enabled: false` stops the FETCH; it does not detach the observer from the
 * cache. So a revisit — whose DEFAULT-view key is already populated — reports
 * `success` with `isPending` false and hands back the page the previous visit
 * left there. A surface that infers readiness from query state therefore renders
 * the pre-restore rows, cards, totals and error surfaces for the whole restore
 * window, under a view the user is about to leave.
 *
 * Zeroing the data HERE, at the one point every consumer routes through, is why
 * this is a helper rather than a guard per call site: `data` feeds row rendering,
 * empty-state and loading-label predicates, page clamps, and auxiliary-read
 * gating, and a guard added to only the consumers a ticket happened to name
 * leaves the siblings reading cache.
 *
 * Shared by the web Sessions page and the desktop `SessionsView` — the two
 * surfaces that gate a list read on a persisted view — so the two cannot drift.
 */
export function gateRestoredRead<TData>(
  isViewReady: boolean,
  read: { data: TData | undefined; isPending: boolean }
): { data: TData | undefined; isPending: boolean } {
  if (isViewReady) {
    return { data: read.data, isPending: read.isPending };
  }
  return { data: undefined, isPending: true };
}

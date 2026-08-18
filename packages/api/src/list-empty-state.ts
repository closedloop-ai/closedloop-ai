/**
 * @file list-empty-state.ts
 * @description FEA-4181 — canonical, runtime-agnostic vocabulary for WHY a
 * paginated list (Sessions, Branches, and the KPI/metric surfaces above them)
 * came back with zero visible rows. Before this, a filtered-away result rendered
 * as a bare "no data" indistinguishable from a genuinely-empty scope or a failed
 * read — a wrong date range made a populated staging org look like a total
 * outage, and the default `quality=substantive` filter hid every all-idle scope
 * behind "no sessions" with no signal that hidden rows existed.
 *
 * An honest empty state must NAME the reason and offer the fix. The three
 * mutually-exclusive reasons are:
 *
 * - {@link ListEmptyReason.Unavailable} — the read errored, or the data is still
 *   syncing / not yet hydrated. This is NOT an empty state: never render a false
 *   all-clear here. Highest precedence — an errored read tells us nothing about
 *   whether the scope has rows, so it can never be reclassified as "empty".
 * - {@link ListEmptyReason.Filtered} — the active filters (date window ≠ default,
 *   quality ≠ all, a narrowed facet) are narrowing the scope while zero rows are
 *   visible. Offer to clear/expand the filter.
 * - {@link ListEmptyReason.Empty} — the scope genuinely has no rows. The real
 *   onboarding "nothing yet" state. Only claim this when the read succeeded, is
 *   hydrated, and no filter is active.
 *
 * This is a pure data + pure classifier module (no React, no Prisma) so the web
 * `/sessions` page, the desktop `SessionsView`, the web `/branches` page, and the
 * desktop `BranchesView` all derive the reason identically from the same signals
 * — the same SSOT precedent set by `agent-session-filters` and `idle-concepts`.
 */

/**
 * The three mutually-distinct reasons a list surface shows zero visible rows.
 * A const object + type alias (never a TS `enum`, never bare string literals) so
 * every surface references the same named member.
 */
export const ListEmptyReason = {
  /** Read errored or data is unhydrated / mid-sync — never a false all-clear. */
  Unavailable: "unavailable",
  /** Rows exist but active filters exclude all of them — offer to clear them. */
  Filtered: "filtered",
  /** The scope genuinely has no rows — the onboarding "nothing yet" state. */
  Empty: "empty",
} as const;
export type ListEmptyReason =
  (typeof ListEmptyReason)[keyof typeof ListEmptyReason];

/**
 * The real, observable signals a host derives the empty reason from. Every field
 * is a fact the host already holds; the classifier owns only the precedence so
 * the two web/desktop surfaces of each list can never disagree on what a
 * zero-row result means.
 */
export type ListEmptyStateSignals = {
  /** The read failed (query `isError`) OR the source is unhydrated/mid-sync. */
  isUnavailable: boolean;
  /**
   * Any filter is actively narrowing the result: a non-default date window, a
   * `quality` segment other than `all`, or a narrowed facet/scope. When true and
   * zero rows are visible, the empty is Filtered, not genuinely Empty.
   *
   * This is the ONLY signal that distinguishes Filtered from Empty (review cid
   * 3653717607). An earlier draft also consulted a `totalBeforeFilters` count,
   * but neither host actually holds a count of rows BEFORE its filters — both
   * pass the current filtered `total`. On a stale/out-of-range page that count is
   * `> 0` while zero rows are visible even with NO filter active, so the shortcut
   * mislabeled a page-clamp artifact as "filtered" for the frame before the
   * clamp effect repaired the page. Hosts must instead suppress the empty state
   * until the clamped page is active; the honest Filtered/Empty split rests on
   * whether a filter is genuinely narrowing the scope.
   */
  hasActiveFilters: boolean;
};

/**
 * FEA-4181: derive WHY a list is empty from real signals, with a fixed
 * precedence that can never lie:
 *
 * 1. Unavailable wins outright — an errored or unhydrated read tells us nothing
 *    about whether the scope has rows, so it must never be reclassified as an
 *    "empty" (honest-state rule: no false all-clear over a failed read).
 * 2. Filtered — a filter is actively narrowing the scope while zero rows are
 *    visible. Offer to clear/expand the filter.
 * 3. Empty — the read succeeded, is hydrated, and no filter is active. The
 *    genuine onboarding zero-state.
 *
 * Callers pass this the moment a list resolves to zero visible rows on the
 * clamped/settled page; a populated list never reaches here, and a host must not
 * classify a stale out-of-range page as empty (review cid 3653717607) — clamp it
 * to a valid page first.
 */
export function deriveListEmptyReason(
  signals: ListEmptyStateSignals
): ListEmptyReason {
  if (signals.isUnavailable) {
    return ListEmptyReason.Unavailable;
  }
  if (signals.hasActiveFilters) {
    return ListEmptyReason.Filtered;
  }
  return ListEmptyReason.Empty;
}

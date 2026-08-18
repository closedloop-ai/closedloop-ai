/**
 * ISS-5005: one-time, targeted repair of a persisted Agents saved view's sort.
 *
 * The Agents catalog defaulted to Component ascending. Because internal tools
 * are underscore-prefixed, that put every `_`-prefixed internal first: a
 * production sweep of a 2,133-component org landed on eleven rows carrying 3
 * invocations between them out of 292,875, with an empty LOC/$ column. The
 * landing view of the discovery surface answered none of "which components are
 * used", "which are expensive", "which earn their cost".
 *
 * Changing the hook's default alone would not have reached anyone.
 * `usePersistedTableViewState` writes the resolved view to `localStorage` as
 * soon as its restore effect commits — including when it committed nothing but
 * defaults — so every user who has ever opened the Agents page already has
 * `sortKey: "name", sortDir: "asc"` persisted, and a restore-wins read would
 * hand it straight back forever. The new default would reach only browsers that
 * had never loaded the page. So the repair has to meet the stored view, not just
 * the default.
 *
 * The repair is deliberately NARROW, in three ways:
 *
 *  1. **Only the untouched default moves.** The rewrite fires only for a view
 *     whose sort is EXACTLY the legacy default pair (Component + ascending).
 *     Any other persisted sort — Invocations, Sessions, Type, or Component
 *     DESCENDING — is a choice the user made, and is returned untouched.
 *  2. **Only the sort.** Hidden columns, column order, column widths, grouping,
 *     and metric mode are never read or written here. Bumping the
 *     `agents:saved-view:` key prefix would have been one line and would have
 *     discarded the user's whole layout to change one dimension.
 *  3. **Once.** The caller stamps the view with {@link AGENTS_SAVED_VIEW_VERSION}
 *     after applying it, so a user who deliberately sorts back to Component
 *     ascending is not fought on every load.
 *
 * KNOWN, ACCEPTED LIMIT: a user who explicitly chose Component ascending BEFORE
 * this shipped is byte-indistinguishable from one who never touched the control
 * — the stored view records the pair, not its provenance. Such a user is
 * re-sorted once and keeps their choice from then on (rule 3). The alternative
 * is a fix that reaches almost nobody, which is the finding restated.
 *
 * Pure functions over enum values — no React, no storage, no DOM — so the
 * rewrite is unit-testable on its own and the hook stays responsible only for
 * wiring it to the restore boundary.
 */

import {
  AgentComponentSortDir,
  AgentComponentSortKey,
} from "@repo/api/src/types/agent-component";

/**
 * Schema version stamped onto an Agents saved view once every migration below
 * has been applied to it.
 *
 * `0` (or absent) is a pre-ISS-5005 view that has never been migrated. The
 * restore path compares the persisted version against this constant, applies the
 * gap, and persists the result — so each migration runs at most once per saved
 * view, and a user who reverses a migration's effect by hand keeps their choice.
 *
 * Bump this — and extend {@link migrateSavedSort} — when a future change needs
 * another one-time repair of a persisted view.
 */
export const AGENTS_SAVED_VIEW_VERSION = 1;

/** Version of a saved view that predates any migration marker. */
export const AGENTS_SAVED_VIEW_UNVERSIONED = 0;

/**
 * The saved-view version at which the ISS-5005 usage-default rewrite was
 * introduced. Kept as its own constant so a later migration can bump
 * {@link AGENTS_SAVED_VIEW_VERSION} without silently re-running this one.
 */
const AGENTS_SAVED_VIEW_VERSION_USAGE_DEFAULT_SORT = 1;

/**
 * The sort the catalog defaulted to before ISS-5005, and therefore the ONLY
 * persisted pair {@link migrateSavedSort} rewrites. Also the flag-OFF default,
 * so the dark path stays byte-identical to what shipped before.
 */
export const LEGACY_AGENTS_DEFAULT_SORT = {
  sortKey: AgentComponentSortKey.Name,
  sortDir: AgentComponentSortDir.Asc,
} as const;

/**
 * The usage-bearing default the catalog lands on when the flag is ON: the most-
 * invoked components first.
 *
 * Invocations (not Sessions, not LOC/$) because it is the headline the summary
 * strip already leads with, it is populated for every component kind, and it
 * orders the table by the question the landing view exists to answer. LOC/$
 * would have been a worse default for the same reason the finding flagged it:
 * it is measured on a small verifiable-kind subset, so sorting by it would put
 * an empty column in charge of the first screen.
 *
 * Exported so the hook's fresh-view default and this migration's target are ONE
 * definition — a future change to the default cannot drift from what the
 * migration rewrites toward.
 */
export const USAGE_AGENTS_DEFAULT_SORT = {
  sortKey: AgentComponentSortKey.Invocations,
  sortDir: AgentComponentSortDir.Desc,
} as const;

export type AgentsSavedSort = {
  sortKey: AgentComponentSortKey;
  sortDir: AgentComponentSortDir;
};

/**
 * Apply every saved-view sort migration this build knows about to a persisted
 * sort last stamped at `fromVersion`, and report the version the result should be
 * re-stamped with.
 *
 * The sort is returned unchanged for a view already at
 * {@link AGENTS_SAVED_VIEW_VERSION} or beyond — including a view written by a
 * NEWER build than this one, whose higher version is preserved rather than rolled
 * back, so a user moving between builds never has a future migration silently
 * re-run against them.
 *
 * A view whose sort is not the legacy default still advances the version: there
 * is nothing to repair, and stamping it means the next load skips this check
 * entirely instead of re-deriving the same no-op.
 */
export function migrateSavedSort(
  sort: AgentsSavedSort,
  fromVersion: number
): { sort: AgentsSavedSort; version: number } {
  if (fromVersion >= AGENTS_SAVED_VIEW_VERSION) {
    return { sort, version: fromVersion };
  }
  // v1 (ISS-5005): move the never-touched alphabetical default onto the
  // usage-bearing one. Guarded on the version AND on the sort still being the
  // legacy pair, so an explicit choice is never overwritten and a user who sorts
  // back to Component ascending after the migration keeps that.
  const shouldRewrite =
    fromVersion < AGENTS_SAVED_VIEW_VERSION_USAGE_DEFAULT_SORT &&
    sort.sortKey === LEGACY_AGENTS_DEFAULT_SORT.sortKey &&
    sort.sortDir === LEGACY_AGENTS_DEFAULT_SORT.sortDir;
  return {
    sort: shouldRewrite ? { ...USAGE_AGENTS_DEFAULT_SORT } : sort,
    version: AGENTS_SAVED_VIEW_VERSION,
  };
}

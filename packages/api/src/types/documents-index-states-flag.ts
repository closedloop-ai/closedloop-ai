/**
 * The single key gating the Documents index's six-state contract (ISS-8940,
 * PRD-695 §2).
 *
 * ## What it gates
 *
 * The index's answer to "what am I looking at": loading, populated, first-use
 * empty, no-results-under-a-search, a blocking read failure with retry, and a
 * failed background refresh that keeps the rows it already has. Off, the index
 * derives its states the way it did before — a read failure with cached rows
 * says nothing at all, and a zero-row read under an active search claims a
 * filter is hiding documents that do not exist.
 *
 * ## Why ONE key for all six, and not one per state
 *
 * The six are a partition of one variable, not six independent switches. A
 * build where the no-results copy is the new one but the failed-refresh notice
 * is still absent is a combination nobody designed: the same read would be
 * described by two different vocabularies depending on which way it failed.
 * They flip together because they are one answer, not six.
 *
 * ## Web-only, deliberately
 *
 * Per operator directive (2026-08-30) desktop Labs toggles are deprecated, and
 * there is nothing here to keep in step with anyway: the desktop shell has no
 * Documents destination — `DESKTOP_SHELL_ROUTE_NAV_IDS[ShellNavigationRouteId.Documents]`
 * is `null` in `apps/desktop/src/renderer/navigation/route-table.ts`, so no
 * desktop route resolves to this surface and the renderer only ever links a
 * document out to its web href. A second gate for a surface that does not mount
 * would be a key that can only drift.
 *
 * Lives in this dependency-free `@repo/api` module to match the convention its
 * sibling flag keys follow, so the literal has one definition a rename can
 * reach.
 */
export const DOCUMENTS_INDEX_STATES_FLAG_KEY =
  "documents-index-states" as const;

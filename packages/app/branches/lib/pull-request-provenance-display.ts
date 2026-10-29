// The words a pull-request surface uses when a provenance field was never
// measured. Lightweight and dependency-free so any `"use client"` surface can
// import a label without dragging a heavier module into its bundle — the same
// arrangement as the sibling `checks-status-display.ts`.
//
// Two surfaces read these: the PR picker row (`select-pr-dialog.tsx`) and the
// Branch detail's delivered panel. Both name an unattributed author with the
// SAME words, which is why the literal lives here rather than at each call site.
//
// The unmeasured BASE REF is deliberately not one label for every surface. In a
// table-like row it is `RENDER_MISSING` (`branch-row.ts`), which reads as an
// absence because a column header supplies the noun; a prose line has no header,
// so it names the field itself. This module owns the prose form so a third
// surface imports it instead of inventing a fourth spelling.

/** No producer reported this pull request's own base ref. */
export const PULL_REQUEST_BASE_UNKNOWN_LABEL = "Base branch unknown";

/** No producer attributed this pull request to a login. */
export const PULL_REQUEST_AUTHOR_UNKNOWN_LABEL = "Author unknown";

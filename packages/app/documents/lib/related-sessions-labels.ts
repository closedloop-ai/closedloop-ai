/**
 * ISS-7235 — the Related Sessions field's user-facing copy, split out of
 * `related-sessions-section.tsx` (PR #5670 review).
 *
 * Import-free on purpose, the same split `document-type-labels.ts` makes. The
 * section itself is a `"use client"` component whose import graph reaches
 * `@repo/collaboration` and the React runtime; a Playwright spec that needs to
 * assert this copy cannot pull that graph into the test process, and inlining
 * the strings at the assertion site would give the copy a second owner that
 * drifts silently.
 */

export const RELATED_SESSIONS_SECTION_TITLE = "Related Sessions";

/**
 * The detail field's empty state is a SENTENCE, not the grid's em-dash: a lone
 * dash under a section heading reads as a rendering failure rather than as an
 * established "none".
 */
export const RELATED_SESSIONS_EMPTY_MESSAGE =
  "No sessions have contributed to this artifact yet.";

export const RELATED_SESSIONS_ERROR_MESSAGE =
  "Could not load related sessions.";
export const RELATED_SESSIONS_LOADING_MESSAGE = "Loading related sessions…";

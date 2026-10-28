/**
 * ISS-9560 — the closed-by-default key gating ONE artifact-status label per
 * vocabulary, and ONE honest render for a status this build does not recognize.
 *
 * ## Why one key for every surface
 *
 * The ticket is that the product states an artifact's status in several places
 * and does not agree with itself about how: the My Tasks board prints the raw
 * wire token (`CHANGES_REQUESTED`), the Slack/Linear unfurl falls through to
 * the artifact TYPE label (an unfurl reading "Issue, Issue"), the status badges
 * dress a status they cannot read as Draft, and the two per-type status icons
 * announce the literal word "Status". Gating those apart would ship exactly the
 * disagreement the ticket exists to remove — a board that says "Changes
 * Requested" beside a badge that still says `IN_PROGRESS`. One key flips the
 * convergence, or none of it.
 *
 * ## What flipping it ON changes on screen
 *
 * - **My Tasks board**: the status chip reads the canonical label
 *   ("Changes Requested"), not the raw column value, resolving through the
 *   card's OWN vocabulary — the one its status icon already uses — so the two
 *   halves of one card cannot disagree about whether the status is recognized.
 *   The PRIORITY chip is NOT part of this key; ISS-9094 owns that half.
 * - **Document/Issue status badges**: a status outside the vocabulary the map
 *   covers reads "Unknown", and wears an unfilled dashed chip rather than the
 *   Draft/Backlog treatment it used to borrow. NOT the status picker — its
 *   options come from the same closed enums its label maps exhaust, so it has
 *   no unrecognized-status case for this key to change.
 * - **`DocumentStatusIcon` / `IssueStatusIcon`**: the accessible name of an
 *   unrecognized status becomes "Unknown, <the sentence>" instead of the literal
 *   word "Status". The MARK is unaffected — ISS-9557 already made it the
 *   `blank-ring` this vocabulary never claims.
 *
 * OFF (the default, per the ISS-4779 closed-by-default UI policy) every one of
 * those surfaces renders exactly as it does today.
 *
 * The `apps/app/lib/og-metadata.ts` unfurl is DELIBERATELY NOT behind this key:
 * it is a server module with no flag seam, and its "Issue, Issue" fall-through
 * is a plain defect restoring already-intended behavior (operator decision,
 * 2026-09-10 — "do not gate the API side").
 *
 * The tag-search PROJECT row is not here either, though ISS-9560 scoped it.
 * PR #6973's review established the row cannot render at all: `ProjectsSection`
 * has exactly ONE render site, fed by `searchByTag`, which returns
 * `projects: []` on every return path and queries only `ArtifactType.DOCUMENT`.
 * So `PROJECT_STATUS_LABELS` has one production consumer and it is unreachable,
 * and resolving a label there changes nothing a reader can see while adding a
 * test that asserts a payload the route cannot produce. Whether tag search
 * should return projects at all is a product question, not this key's business
 * — reach for that answer before adding the row back.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so a bundle-sensitive `"use client"` badge can import
 * the literal without dragging one in — and so web and the desktop renderer,
 * which resolves the signed-in account's PostHog assignment from this same key
 * space, cannot end up gated on two differently-named keys.
 */
export const ARTIFACT_STATUS_LABEL_HONESTY_FLAG_KEY =
  "artifact-status-label-honesty" as const;

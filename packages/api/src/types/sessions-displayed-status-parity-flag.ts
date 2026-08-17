/**
 * ISS-4556 / ISS-4559: the single cross-surface flag key gating the Sessions
 * DISPLAYED-status single source of truth — one derivation behind the row's
 * Status value, the Status sort key, and the Status facet predicates, on web and
 * desktop alike.
 *
 * One key for both findings because they are two halves of one defect. FEA-4301
 * introduced `projectDisplayedSharedStatus` and wired it into the desktop Status
 * SORT but not the row's `status` field (ISS-4556), and left the ACTIVE facet
 * carrying an awaiting-input exclusion the projection has no counterpart for
 * (ISS-4559). Rolling them separately is the inconsistent state: fixing the row
 * status alone would make an ended+awaiting row display a status neither facet
 * returns, and fixing the facet alone would leave desktop and web rendering
 * different Status values for the same session.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no heavy
 * transitive graph) precisely so both surfaces import the SAME literal instead of
 * redeclaring it:
 *  - the cloud read path (`apps/api`) resolves it per-viewer through PostHog and
 *    threads the result onto `AgentSessionScope.displayedStatusParity`, which
 *    `buildStatusFacetPredicate` reads.
 *  - the desktop main process registers it as a Labs toggle via
 *    `DESKTOP_SESSIONS_DISPLAYED_STATUS_PARITY_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`), which gates the Local lane's
 *    row status and `matchesStatusFilter`.
 *
 * Importing one constant on both sides means a future rename touches a single
 * definition — it cannot silently split PostHog and Desktop the way two parallel
 * string literals could (wongk, PR #4202).
 */
export const SESSIONS_DISPLAYED_STATUS_PARITY_FLAG_KEY =
  "sessions-displayed-status-parity" as const;

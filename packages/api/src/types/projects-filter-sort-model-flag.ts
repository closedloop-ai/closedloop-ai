/**
 * The flag key selecting the unified FILTERING AND SORTING MODEL on the team
 * Projects list (ISS-9346, PRD-706 R10-06).
 *
 * ## What it selects
 *
 * Closed, the list is what it has always been: no row filter at all, and a sort
 * whose ties fall back to whatever order the server happened to return.
 *
 * Open, the surface gains the two halves R10 specifies, both taken from the
 * champion the prototype was recomposed onto in ISS-9345:
 *  - the champion `FilterPopover` — assignee, priority, status and an updated
 *    date window — with the active-filter chips and their clear affordance;
 *  - deterministic ordering: every sort column breaks a tie by name and then by
 *    id, un-negated, so ascending and descending agree about the order inside a
 *    tie and a re-fetch cannot reshuffle equal rows.
 *
 * ## ONE key, and why there is no second one
 *
 * The team Projects list is a WEB-ONLY surface. The desktop renderer's view
 * switch (`apps/desktop/src/renderer/App.tsx`) has no Projects case, its
 * `NavId` has no Projects member, and `route-table.ts` maps no
 * `/teams/:teamId/projects` path — an unmapped href is dropped by the navigate
 * guard. So the perceivable change has no desktop analogue to diverge from, and
 * a second key would gate nothing.
 *
 * That is not a licence to invent one later either: `DesktopFeatureFlagProvider`
 * resolves the signed-in account's PostHog assignment and nothing else, so if
 * Projects ever mounts on desktop it reads THIS key from the same key space.
 * There is no desktop Labs toggle to pair with it and no desktop registry entry
 * to add alongside it.
 *
 * ## Where it is read
 *
 * Twice, and deliberately — each read swaps a whole shape of its own rather than
 * steering one derivation from a distance:
 *  - the page (`…/teams/[teamId]/projects/page.tsx`) picks between the plain
 *    table and the filtered surface that wraps it;
 *  - the table (`…/components/projects-table.tsx`) picks between the two sort
 *    configuration tables.
 * Neither passes the boolean on.
 *
 * Closed by default. The legacy path is the flag-off branch and stays a live
 * rollback until cutover.
 */
export const PROJECTS_FILTER_SORT_MODEL_FLAG_KEY =
  "projects-filter-sort-model" as const;

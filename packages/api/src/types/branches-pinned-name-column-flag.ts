/**
 * ISS-6959 (ISS-4779 closed-by-default policy): the single cross-surface flag
 * key gating the pinned Name column on the Branches list.
 *
 * The Branches table declares 1735px of tracks and its host scroll container is
 * about 1008px at a 1280px viewport, so scrolling right to read Status or Last
 * active carries Name, Owner and Collaborators off-screen and leaves every row
 * as a run of values with nothing saying which branch they belong to. With the
 * flag ON the Name column is pinned to the left edge of that scroll container
 * and stays legible at every scroll offset; with it OFF the table scrolls
 * exactly as it does today.
 *
 * Gated on both surfaces because the Branches list exists on both and renders
 * from ONE shared component (`ApprovedBranchesTable` via `BranchesListSurfaceV2`), so
 * an ungated pin would appear everywhere at once.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so BOTH surfaces import the SAME literal instead of
 * redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop renderer resolves the byte-for-byte-equal key from the
 *    signed-in account's PostHog assignment, delivered over the IPC bridge,
 *    under the alias `DESKTOP_BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags-labs-surfaces.ts`).
 *
 * Importing one constant on both sides means a future rename touches a single
 * definition — it can't silently split the two surfaces' reads of it the way
 * two parallel string literals could. The desktop parity test asserts each
 * surface alias resolves to this constant, and that the desktop default is OFF.
 *
 * Deliberately NOT folded into `grid-table-v2`: that key gates what a column
 * HEADER and a ROW can do across every surface rendering the shared grid, and
 * this pins ONE column on ONE list. Riding that key would flip the pin on for
 * Sessions, Agents, Routines, Packs, Documents and Compliance the moment the v2
 * pass opened, none of which this ticket measured or reviewed.
 */
export const BRANCHES_PINNED_NAME_COLUMN_FLAG_KEY =
  "branches-pinned-name-column" as const;

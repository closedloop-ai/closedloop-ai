/**
 * ISS-9665 — the single web flag gating the UNSET-priority affordances.
 *
 * ## Why it lives in `@repo/app/documents`, not `@repo/api`
 *
 * Every consumer is UI — the shared document components in this package and five
 * `apps/app` surfaces: the two that build artifact row models (My Issues and the
 * project artifact tree), the projects grid, the project overview's Properties
 * panel, and the Projects table in tag search results (ISS-9441). No server
 * package and no `apps/api` route reads
 * it. `packages/api/src/types/` is reserved for types
 * used by BOTH apps, so a frontend-only key co-locates with the document UI it
 * gates. (`PRIORITY_UNSET_VALUE` in `@repo/api/src/types/search-query` is the
 * opposite case and correctly stays there: the search grammar parses it
 * server-side and the facet renders it client-side.)
 *
 * ## What the ticket decided
 *
 * `toDocument()` folded a stored `NULL` priority into `MEDIUM`, so one artifact
 * serialized `MEDIUM` on `/documents` and `null` on `/search`,
 * `/artifact-links/resolved` and the project tree. The operator's ruling
 * (2026-09-07) is that `NULL` is represented honestly end to end: "no priority"
 * is a real state a user can see and filter. The serialization half of that is
 * a correctness fix and ships ungated — an API must not report a value the
 * artifact does not hold. This key gates only the part a user PERCEIVES.
 *
 * ## What flipping it ON changes on screen
 *
 * - **Artifact grids** (project documents table, My Issues): a row whose
 *   priority is genuinely unset renders the empty-value dash and the "Set
 *   priority" trigger that the cell has always had for this case, instead of a
 *   `Medium` glyph the artifact never had. Grouping by priority buckets it under
 *   the existing "No priority" section, and it sorts last — both already the
 *   established behaviour of `group-by.ts` and `comparePriorityValues`.
 * - **Projects grid** (ISS-9441): a project whose priority is unset renders the
 *   same empty-value dash in its priority cell instead of `Medium`, and sorts
 *   last in either direction. Its menu gains the "No priority" item too, since
 *   ISS-9441 made `projects.priority` nullable and flipped
 *   `ARTIFACT_PRIORITY_SUPPORT[Project].allowsUnset`.
 * - **Project overview** (ISS-9441, the Properties panel): the priority cell
 *   swaps from the `Select` it shipped with to the ISS-9307 champion
 *   `ArtifactPriorityEditor`, which shows the empty-value mark beside "No
 *   priority" instead of `Medium` and offers the clear. OFF keeps the `Select`
 *   whole, caret and four members included.
 * - **Search results, Projects table** (ISS-9441, tag search): an unset project
 *   priority shows the empty-value mark beside "No priority" instead of a
 *   `Medium` badge.
 * - **The priority menu** (artifact grid cell and artifact rows on detail
 *   pages): gains a "No priority" item that CLEARS the field. Same dropdown,
 *   same label the group header already uses; no new badge, chip, or colour.
 * - **The documents filter facet**: gains a "No priority" option, so the state
 *   is filterable rather than merely visible.
 *
 * OFF (the default, per the ISS-4779 closed-by-default UI policy) every one of
 * those surfaces renders exactly as it does today: an unset priority is
 * displayed as `MEDIUM`, the menu offers the four members only, and the facet
 * has no unset option.
 *
 * ## One key for both shells
 *
 * When this key shipped, the desktop renderer mounted no surface that rendered
 * artifact priority, so it was a web-only change. That stopped being true with
 * ISS-10332: the Sessions and Branches grids render and edit priority on web
 * and on the desktop renderer in cloud mode, and their clear item and the
 * Branches facet's "No priority" option read this same key. The desktop
 * resolves the signed-in account's PostHog assignment from the same key space,
 * so this ONE key is the gate on every shell that mounts it — there is no
 * desktop toggle to pair with it (Labs toggles are retired per the operator's
 * 2026-08-30 directive regardless).
 */
export const ARTIFACT_PRIORITY_UNSET_FLAG_KEY =
  "artifact-priority-unset" as const;

import { GRID_TABLE_V2_FLAG_KEY } from "@repo/api/src/types/grid-table-v2-flag";
import type { GridTableColumn } from "@repo/design-system/components/ui/grid-table";
import { CARD_FALLBACK_BREAKPOINT } from "@repo/design-system/lib/column-order";
import {
  DS_CHIP_FIT_GEOMETRY,
  estimateChipPlusOverflowWidthPx,
} from "./session-qualifier-fit";

/**
 * The Sessions table's column geometry — the canonical DATA-column order, each
 * column's grid track, and the leading/trailing chrome tracks.
 *
 * Hoisted out of `sessions-table.tsx` (ISS-4890) so the render order is ONE
 * declaration two consumers read rather than a component-local constant a second
 * module has to re-type:
 *  - `SessionsTable` builds its `columns` + `gridTemplateColumns` from
 *    {@link SESSIONS_COLUMN_SPECS};
 *  - the persisted-view migration (`sessions-saved-view-migration.ts`, wired in
 *    `use-sessions-view-state.ts`) reads {@link SESSIONS_DATA_COLUMN_ORDER} to
 *    decide where a relocated column canonically belongs.
 *
 * This module is deliberately DEPENDENCY-LIGHT — a type-only import plus one
 * dependency-free constant — so the Sessions view-state hook can read the
 * canonical order without pulling the table's component graph (lucide, badges,
 * chips, the design-system component tree) into every surface that only needs
 * the hook.
 */

const COST_COLUMN_ID = "cost";

/** Column id of the always-shown, non-toggleable autonomy score column. */
export const SESSIONS_AUTONOMY_COLUMN_ID = "autonomy";

/** Column id of the Cost column — the one ISS-4890 relocates. */
export const SESSIONS_COST_COLUMN_ID = COST_COLUMN_ID;

/** Column id of the optional trailing caller-supplied column. */
export const SESSIONS_EXTRA_COLUMN_ID = "extra";

/**
 * ISS-6005: the id of the record-mutation `Updated` column.
 *
 * Named rather than repeated as a literal because three separate declarations
 * have to agree about it — the column spec, the default-hidden seed, and the
 * glanceable-embed exclusion in `use-sessions-view-state` — and a column that is
 * hidden in two of the three but not the third is exactly the drift this
 * constant removes. Declared up here, with the other ids, because
 * `SESSIONS_COLUMN_SPECS` reads it during module evaluation.
 *
 * Deliberately NOT reused by `sessions-saved-view-migration`'s frozen
 * `SESSIONS_HIDDEN_MIGRATION_V1_COLUMN_IDS`: that array is a shipped migration
 * payload describing what V1 wrote, so it must not follow a later rename.
 */
export const SESSIONS_UPDATED_COLUMN_ID = "updated";

/**
 * ISS-5770: the id of the linked-BRANCHES column.
 *
 * Plural, because a session can have more than one branch — and because it is
 * the id the Sessions prototype's own `COLUMN_SPECS` uses
 * (`apps/prototypes/app/p/sessions/components/sessions-table.tsx`). Production
 * spelled it `branch` while rendering the label "Linked branches", so the two
 * lists that are meant to BE the same list agreed on the visible string and
 * disagreed on the key any comparison would join on. That is the exact shape
 * ISS-5713 is about: nothing failed, because nothing mechanically compared them.
 *
 * The visible label is unchanged ("Linked branches") — this renames the key, not
 * the column.
 */
export const SESSIONS_BRANCHES_COLUMN_ID = "branches";

/**
 * The pre-ISS-5770 spelling of {@link SESSIONS_BRANCHES_COLUMN_ID}.
 *
 * This id is PERSISTED in users' saved views — inside `columnOrder`, inside the
 * hidden-column set, and potentially as a stored sort key — so the rename cannot
 * be a pure find-and-replace. A saved view carrying `branch` must keep both the
 * slot the user dragged the column to and their shown/hidden choice.
 */
export const SESSIONS_LEGACY_BRANCHES_COLUMN_ID = "branch";

/**
 * Persisted column ids this build has RENAMED, mapped old → new.
 *
 * Read at the restore boundary by {@link normalizeSessionColumnId} rather than
 * applied as a one-time versioned migration. Both mechanisms exist in this
 * codebase — `sessions-saved-view-migration.ts` carries the ISS-4890 one-time
 * relocation — and the choice here is deliberate:
 *
 *  - The ISS-4890 migration repairs a column's POSITION, which is a judgement
 *    about where a column should sit. It must run once and then leave the user
 *    alone, or it fights someone who drags the column back.
 *  - A rename is not a judgement, it is a spelling. There is no user choice to
 *    respect and nothing to fight: `branch` and `branches` are the same column,
 *    so the mapping is correct on every read, forever.
 *
 * A read-time alias is also the only one of the two that covers all three
 * hazards uniformly. The versioned migration rewrites `columnOrder` only; the
 * hidden-column set and any stored sort key are read on other paths, and a
 * legacy id surviving in either would silently stop hiding the column or resolve
 * a sort to nothing. Normalizing on read fixes all of them at once and is
 * idempotent, so a view written by an older build that is then read by a newer
 * one — the version-skew case the repo's compatibility rule names — degrades to
 * exactly the right column instead of to nothing.
 *
 * Per the repo's Compatibility Guardrail this tolerance is not to be removed
 * without explicit human approval.
 */
export const SESSIONS_RENAMED_COLUMN_IDS: Readonly<Record<string, string>> = {
  [SESSIONS_LEGACY_BRANCHES_COLUMN_ID]: SESSIONS_BRANCHES_COLUMN_ID,
};

/**
 * One persisted column id, resolved to the id this build renders.
 *
 * Unknown ids pass through unchanged: a persisted view can legitimately carry a
 * column some other build knows about, and dropping it here would silently
 * discard a slot the user arranged. The valid-id filters downstream already
 * decide what to keep; this function's only job is the rename.
 */
export function normalizeSessionColumnId(columnId: string): string {
  return SESSIONS_RENAMED_COLUMN_IDS[columnId] ?? columnId;
}

/**
 * The room (px) the Cost cell needs for its VALUE — the content box `$772.39`
 * was measured against, and the only part of the track that is about legibility.
 *
 * ISS-5356 declared this as 100px of content PLUS a 24px reorder grip lane,
 * because a reorderable cell then spent `pl-9` + `pr-3` = 48px of padding.
 * ISS-5812 removed the lane, so the cell spends `pl-3` + `pr-3` = 24px and the
 * same 124px track now yields a 100px content box instead of 76.
 *
 * The track is deliberately NOT narrowed back to 100. It could be — 100 would
 * leave a 76px content box, which is what Cost shipped with for its whole
 * pre-ISS-5356 life and is still comfortably over the ~56px `$772.39` measures
 * — so this is a choice, not a forced floor. It stays at 124 because the value
 * is the one Sessions cell whose overflow is a LIE rather than an ellipsis (a
 * clipped currency string reads as a smaller number, the ISS-4891 defect), and
 * because the fold budget and the saved-view relocation slots are pinned to
 * this width by `sessions-table-columns.test.tsx` and
 * `sessions-saved-view-migration.test.ts`. Cost keeps the roomier box; every
 * other column got its 24px back as content.
 *
 * Cost is singled out for a derived comment at all because it is the one
 * Sessions column whose overflow is a lie rather than an ellipsis: every other
 * cell holds truncating text that still reads as truncated, while a clipped
 * currency string reads as a smaller number. That is the same asymmetry ISS-4891
 * was filed about, and it is pinned by `sessions-table-columns.test.tsx` plus the
 * `textOverflows` leg of the desktop `sessions-table-legibility` e2e.
 */
export const SESSIONS_COST_COLUMN_WIDTH_PX = 124;

/**
 * Minimum width (px) of the leading (Session Name) track. Every data column
 * starts after it, so it is the first term of the fold budget arithmetic below —
 * declared as a number and interpolated into the track so the two can never
 * drift apart. Also the persisted saved-view baseline
 * (`use-sessions-view-state`), so changing it rewrites geometry users already
 * have stored.
 */
export const SESSIONS_LEAD_COLUMN_MIN_WIDTH_PX = 300;

/** Grid track for the leading (Session Name) column. */
export const SESSIONS_LEAD_GRID_TRACK = `minmax(${SESSIONS_LEAD_COLUMN_MIN_WIDTH_PX}px, 1fr)`;

/** Grid track for the optional trailing caller-supplied column. */
export const SESSIONS_EXTRA_COLUMN_GRID_TRACK = "minmax(140px, 0.5fr)";

/**
 * ISS-4788: how far right (px, cumulative from the table's left edge) a Sessions
 * data column may end and still be guaranteed visible without horizontal
 * scrolling. A column whose `gridTemplateColumns` tracks sum past this point is
 * not on screen at rest on a supported surface.
 *
 * Since ISS-4889 that is "not on screen", not "cut in half": `snapFoldToColumns`
 * makes the fold land on a column boundary, so a column is either whole or
 * absent, never straddling. The budget still earns its keep — it governs the
 * DECLARED order, which is what SSR and the first paint render before any
 * container has been measured, and what a persisted user order is replayed
 * against (and, since ISS-4890, what that persisted order is migrated TOWARD).
 *
 * This is deliberately its OWN constant rather than a second reading of
 * {@link CARD_FALLBACK_BREAKPOINT}: "where does the card list take over" and
 * "how far right may a must-read value sit" are different questions that will
 * want to move independently. It is *derived* from the breakpoint rather than
 * re-typing 768, because at the one site where the derivation is sound it is
 * exactly right — SessionsTable always supplies a `cardRender` and its `mode`
 * defaults to `auto`, so below the breakpoint the card list renders and the grid
 * is never painted narrower than that. Deriving keeps the two honest while they
 * agree; splitting the name is what lets them disagree later.
 *
 * Note this is a floor, not the observed failure: the clip in ISS-4788 happened
 * at the ~1,108px desktop content width. Holding the stricter 768px budget means
 * a column that satisfies it is safe at every width the grid renders, including
 * that one. If SessionsTable ever drops its `cardRender` or is mounted
 * `mode="expanded"` at a narrow width, the derivation stops holding and this
 * needs its own literal.
 */
export const SESSIONS_LEGIBLE_COLUMN_BUDGET_PX = CARD_FALLBACK_BREAKPOINT;

/**
 * Each data column carries its grid width so the columns show/hide menu can drop
 * a column AND its track in lockstep.
 *
 * FEA-4006: the leading columns mirror the agent-detail Sessions mock
 * (`apps/prototypes/app/p/agents/components/sessions-table.tsx`) — Name (lead),
 * Owner, Status, Repository, Branch, PR, Cost, Started — in that order. The
 * mock's inline "Version" column is the agent-detail-only trailing `extra`
 * column (data-gated; see `detail-sessions-tab.tsx`). Owner is now a
 * shown-by-default column (was opt-in) so the web and desktop Sessions lists no
 * longer inject it per-surface.
 *
 * Autonomy / Merge / Harness / Model / Duration / Last active are operational
 * columns the main Sessions list (and telemetry) carry beyond the mock; they
 * follow the mock's column set and remain hideable via the View menu.
 *
 * ISS-4788 promoted Cost ahead of Repository so its track ended inside
 * {@link SESSIONS_LEGIBLE_COLUMN_BUDGET_PX}. ISS-5315 supersedes that placement
 * with the prototype's order — see the note on {@link SESSIONS_COLUMN_SPECS} for
 * why that is safe now and what the budget assertion pins instead.
 *
 * ISS-4889: this ordering decides which columns are worth seeing FIRST; it never
 * stopped the fold from cutting one in half (post-ISS-4788 the PR column
 * inherited that). `snapFoldToColumns` is what guarantees whichever columns land
 * before the fold are rendered WHOLE — see `column-fold.ts`.
 *
 * ISS-4890: this order is also the target a PERSISTED column order is migrated
 * toward. Until then the ISS-4788 placement only reached users who had never
 * drag-reordered a header — everyone else kept Cost in its old post-fold slot,
 * still rendering `$772.3` where the row's cost was `$772.39`.
 */
/**
 * ISS-4848: the Status column's id, read by BOTH the column spec below and the
 * sync-state fold's visibility guard (`session-status-fold.ts`). The fold stands
 * down when Status is hidden from the View menu — it has nowhere to render then,
 * and suppressing the name-cell badge too would leave an uploading row with no
 * sync signal anywhere in the grid. Declaring the id here, alongside the column
 * geometry ISS-4890 hoisted into this module, means the id the guard checks and
 * the id the grid renders cannot drift apart.
 */
export const SESSIONS_STATUS_COLUMN_ID = "status";

/**
 * Width (px) of the Owner column.
 *
 * Named rather than inlined because ISS-5282's first draft spent part of it,
 * narrowing Owner to 136px to buy width for the qualifiers column. That is
 * reverted: 136px does not hold the "Firstname Lastname" it claimed to (see
 * the ISS-5282 qualifiers-column arithmetic), and the
 * narrowing was applied unconditionally — outside the
 * `sessions-row-qualifiers-column` gate — so half of a closed-by-default change
 * reached every user on day one (review cid 3731452656). 180px is the shipped
 * value and ISS-5282 left it alone; ISS-5666, which retired that gate, does too.
 */
export const SESSIONS_OWNER_COLUMN_WIDTH_PX = 180;

/**
 * FEA-4209: the id of the linked-PROJECT(s) column.
 *
 * Rendered only while `grid-table-v2` is ON **and** the host wired the seam that
 * supplies the chips — see {@link SESSIONS_ISSUES_COLUMN_ID} for why the seam is
 * half of the gate. Hideable from the View menu like every other optional
 * column, and reorderable like every data column, so it is included in the
 * view-state hook's orderable id set.
 */
export const SESSIONS_PROJECTS_COLUMN_ID = "projects";

/**
 * Header for the linked-projects column.
 *
 * "Owning project", not "Projects" (wongk review). The bare noun read as the
 * same dimension the `sessions-project-facet` filter narrows on, and the two are
 * NOT the same dimension:
 *
 * - This cell reads `AgentSessionListItem.project`, which the API resolves from
 *   the session's LINEAGE — the source artifact it was launched from, or its
 *   loop's artifact (`project-resolution.ts`, FEA-1749: lineage only, no
 *   repository fallback). That is the project the run BELONGS to.
 * - The facet filters on the session artifact's `sourceLinks` — a `RELATES_TO`
 *   edge to a document that lives in some project (`buildProjectLinkWhere`,
 *   ISS-5355). That is the set of projects the run TOUCHED, and a session
 *   parents to neither, one, or a different one of them.
 *
 * So a "Project A" filter can legitimately return a row whose cell names Project
 * B, or an em dash. Naming the OWNING relation explicitly is what keeps that
 * honest; aligning the cell to the facet instead would need a new projection
 * (the linked documents' projects), which is a contract change this ticket does
 * not make and which would also lose the more useful fact.
 *
 * Singular deliberately: the contract resolves at most one project per session,
 * and a session has exactly one owner or none. The cell is still the shared
 * multi-chip cell — reuse of one fit/overflow/accessible-name rule with the
 * `Linked issues` column — but the header describes the RELATION, not the
 * component.
 */
export const SESSIONS_PROJECTS_COLUMN_LABEL = "Owning project";

/**
 * FEA-4210: the id of the linked-ISSUES column.
 *
 * Rendered only while `grid-table-v2` is ON **and** the host wired the seam that
 * supplies the chips. The seam is genuinely half of the gate rather than
 * belt-and-braces: both fields these two columns read (`project`,
 * `linkedArtifacts`) are projected by the CLOUD list only — the desktop local
 * LIST producer emits neither (`shared-agent-sessions-api.ts`). A flag-only gate
 * would grow two tracks of em dashes on a locally-fed Sessions list the moment
 * its Labs toggle was flipped, on an already ~1,000px-overflowing grid.
 *
 * ISS-5617 narrowed that claim without changing this gate: the desktop local
 * DETAIL projection now emits `linkedArtifacts`, but the local LIST projection
 * still does not, and `project` has no local producer at all. So the seam stays
 * correct for this list — just don't read it as "local mode has no linked
 * artifacts anywhere", because the session-detail pane now does.
 *
 * The seam is per SOURCE, not per surface (wongk review): the desktop's CLOUD
 * mode reads the same HTTP list the web app does, so it opts in too — see
 * `useDesktopLinkedEntityColumns`. Requiring the host to opt in means the
 * source that HAS the data renders the columns and the source that does not
 * never grows them.
 */
export const SESSIONS_ISSUES_COLUMN_ID = "issues";

/**
 * Header for the linked-issues column.
 *
 * "Linked issues" and not "Issues", so it reads as a pair with the "Linked
 * branches" column it sits beside: both name artifacts this session is connected
 * to, as against the columns around them, which describe the session itself. It
 * also keeps the header honest about the relation — these are issues the
 * transcript REFERENCED or created, resolved from the session→document artifact
 * links, not issues assigned to the run.
 */
export const SESSIONS_ISSUES_COLUMN_LABEL = "Linked issues";

/**
 * Horizontal padding (px) a grid body cell spends before any content: `pl-3`
 * (12) plus `pr-3` (12). See `GridTableCell` in `grid-table.tsx`.
 *
 * ISS-5812: this was 48 while a reorderable cell carried a 36px `pl-9` grip
 * lane. That lane is gone from every grid, so a cell spends 24 again and any
 * floor derived from it gets the 24px back as content room.
 */
const GRID_CELL_PADDING_PX = 24;

/**
 * The chip label the floor is sized against — a canonical `FEA-####` issue slug,
 * the shape the `Linked issues` column is full of.
 */
const SESSIONS_LINKED_ENTITY_REFERENCE_LABEL = "FEA-4209";

/**
 * Content room (px) one linked-entity cell needs at its narrowest: one
 * reference-slug chip PLUS the `+N` counter that discloses the rest.
 *
 * DERIVED from the fit's own arithmetic rather than hand-computed, so the floor
 * cannot drift from what the cell actually measures at render time.
 */
const SESSIONS_LINKED_ENTITY_CONTENT_WIDTH_PX = Math.ceil(
  estimateChipPlusOverflowWidthPx(
    SESSIONS_LINKED_ENTITY_REFERENCE_LABEL,
    DS_CHIP_FIT_GEOMETRY
  )
);

/**
 * Floor (px) of both linked-entity tracks: the content room above PLUS the
 * cell's own padding, so the padding is ADDITIVE rather than taken out of the
 * value — the same shape as {@link SESSIONS_COST_COLUMN_WIDTH_PX}.
 *
 * The first draft was a flat 160 with a comment claiming a 136px content box.
 * That subtracted 24 where the cell then actually spent 48, leaving a real
 * content box of 112px
 * against a chip-plus-counter needing 142 — so the documented guarantee was false
 * by 30px, and at the narrowest supported width the counter would have clipped
 * against the cell's own `overflow-hidden`. Deriving both terms is what stops
 * that from recurring; `sessions-table-linked-entity-columns.test.tsx` runs the
 * same arithmetic as a regression.
 *
 * It is still NOT a promise that a long project name renders whole at the floor:
 * the track is `0.5fr` above it, so any real desktop width holds more. What the
 * floor buys is that the first chip AND the affordance disclosing the rest are
 * both reachable. Anything the fit cannot show is named in full by the overflow
 * popover and its accessible name — and, for `Owning project`, where the contract
 * yields at most one chip so the overflow can never fire, by the per-chip
 * tooltip (`SessionLinkedChipsCell`).
 *
 * Both columns sit well past {@link SESSIONS_LEGIBLE_COLUMN_BUDGET_PX}, which is
 * deliberate and costs that budget nothing: the budget is asserted against
 * Status (second track, unmoved by this ticket), and Cost is already documented
 * as sitting past it since ISS-5315. Neither new track is inserted ahead of
 * Status, so the guarantee ISS-4788 established is untouched.
 */
export const SESSIONS_LINKED_ENTITY_COLUMN_MIN_WIDTH_PX =
  SESSIONS_LINKED_ENTITY_CONTENT_WIDTH_PX + GRID_CELL_PADDING_PX;

/** Grid track shared by the linked-projects and linked-issues columns. */
export const SESSIONS_LINKED_ENTITY_COLUMN_GRID_TRACK = `minmax(${SESSIONS_LINKED_ENTITY_COLUMN_MIN_WIDTH_PX}px, 0.5fr)`;

/**
 * ISS-5315: the canonical order is now the one the Sessions prototype specifies
 * — Session (lead), Status, Owner, Autonomy, Repository, Linked branches,
 * Harness, Model, Duration, Cost, Last active — with PR / Merge / Started
 * following as columns that are hidden by default (see
 * {@link SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS}).
 *
 * ISS-5770 removes the `Signals` column ISS-5282 had inserted between Status and
 * Owner, moves `Owning project` to the prototype's slot after Autonomy, puts
 * `Started` back beside `Last active`, and renames the branches column's id to
 * the prototype's `branches`. The order above is now the prototype's own, for
 * every column both sides have.
 *
 * This SUPERSEDES ISS-4788's promotion of Cost to the third slot. That change
 * existed because the fold used to cut a column in half, so a Cost track
 * straddling the viewport edge rendered `$772.3` for a `$772.39` row — a value
 * lie. ISS-4889's `snapFoldToColumns` removed that failure mode structurally: a
 * column is now rendered WHOLE or not at all, so a Cost column past the fold is
 * off-screen (reachable by the scroll affordance ISS-4901 added) rather than
 * truncated. What ISS-4788 bought beyond that was glanceability, and the
 * prototype's order is the product decision about which columns earn the first
 * screen. The budget constant below still governs — it is now asserted against
 * Status, the row's primary state, in `sessions-table-columns.test.tsx`.
 */
export type SessionsColumnSpec = GridTableColumn & {
  width: string;
  /**
   * Track floor (px) when {@link width} is not a plain `<n>px` literal a
   * `parseFloat` can read (a `minmax(…)` track). Every other spec omits it and
   * is measured by its literal width.
   */
  minWidthPx?: number;
  /**
   * ISS-5713: the feature flag this column is gated behind, DECLARED on the spec
   * rather than restated in the render path and again in every consumer.
   *
   * Before this field, gatedness was a property of `SessionsTable`'s render
   * logic only, so the canonical array declared what COULD render while each
   * consumer needing what DOES render hand-maintained its own exclusion list —
   * `e2e/sessions-list-surface.spec.ts` grew a `FLAG_GATED_COLUMN_IDS` literal
   * for exactly this reason, and a PR that added two gated columns broke all
   * five of that spec's tests without touching the file.
   *
   * `null` — not `undefined` — is the UNGATED sentinel: the column renders
   * whenever its host can supply a cell. The field is REQUIRED and non-optional,
   * which is the whole forcing function: `tsc` fails a column added without a
   * gate, so "ungated" is a decision somebody typed rather than a default nobody
   * made. An earlier revision of this comment named `undefined` and pointed at a
   * `SESSIONS_COLUMN_GATES` map; neither exists — the map was folded into this
   * field before it shipped, and the two consumers of gatedness
   * ({@link selectOfferableSessionColumns} and, through it,
   * {@link resolveRenderedSessionColumnIds}) both read `spec.gate` off the spec
   * and treat exactly `null` as ungated.
   */
  gate: SessionsColumnGate | null;
};

/**
 * ISS-5713: a feature-flag key a Sessions column may be gated behind.
 *
 * Its own alias so the gate vocabulary has ONE name that every consumer's
 * signature can spell, instead of each re-typing `typeof GRID_TABLE_V2_FLAG_KEY`
 * and having to be found and edited when a second key is added.
 */
export type SessionsColumnGate = typeof GRID_TABLE_V2_FLAG_KEY;

/**
 * Which gates this BUILD has on, keyed by gate. A per-key map rather than a
 * boolean so adding a second gate key later does not silently re-interpret an
 * existing caller's argument as an answer about the new flag.
 */
export type SessionsColumnGateState = Readonly<
  Partial<Record<SessionsColumnGate, boolean>>
>;

export const SESSIONS_COLUMN_SPECS = [
  // #4480: Status leads, as the prototype's own COLUMN_SPECS does (status, tags,
  // owner). Status is what a reader scans a session list FOR; Owner is a
  // secondary filter dimension, so leading with it demoted the thing the row is
  // actually about. The PR body had described the new order as the prototype's
  // while putting Owner first, which it does not.
  {
    id: SESSIONS_STATUS_COLUMN_ID,
    label: "Status",
    width: "132px",
    sortable: true,
    gate: null,
  },
  // FEA-4300: Owner is sortable; its column id (`owner`) maps to the server sort
  // key `user` at the sort boundary in `SessionsTable`
  // (columnIdToSessionSortKey).
  {
    id: "owner",
    label: "Owner",
    width: `${SESSIONS_OWNER_COLUMN_WIDTH_PX}px`,
    sortable: true,
    gate: null,
  },
  {
    id: SESSIONS_AUTONOMY_COLUMN_ID,
    label: "Autonomy",
    width: "140px",
    gate: null,
  },
  // FEA-4209 / ISS-5770: `Owning project` sits between Autonomy and Repository,
  // the slot the prototype gives `projects`. It answers who/what this run
  // belongs to rather than what the run did.
  //
  // It is NOT the dimension the `sessions-project-facet` filter narrows on, and
  // an earlier revision of this comment claimed it was: the facet matches
  // sessions that LINK to a document in a project, this column names the project
  // the session is PARENTED to. See SESSIONS_PROJECTS_COLUMN_LABEL for why the
  // header spells that out rather than letting the adjacency imply an
  // equivalence that does not hold.
  {
    id: SESSIONS_PROJECTS_COLUMN_ID,
    label: SESSIONS_PROJECTS_COLUMN_LABEL,
    width: SESSIONS_LINKED_ENTITY_COLUMN_GRID_TRACK,
    minWidthPx: SESSIONS_LINKED_ENTITY_COLUMN_MIN_WIDTH_PX,
    gate: GRID_TABLE_V2_FLAG_KEY,
  },
  {
    id: "repo",
    label: "Repository",
    width: "180px",
    sortable: true,
    gate: null,
  },
  // ISS-5315: renamed from "Branch". The cell folds the row's PR summary and
  // merge state into its tooltip (see `renderLinkedBranchesCell`), which is what
  // lets the separate PR and Merge columns default to hidden without the grid
  // losing any fact it used to state.
  //
  // ISS-5770: the id is `branches`, matching the prototype's spec. It was
  // `branch` — the LABEL already agreed while the id did not, which is precisely
  // how two lists that are supposed to be the same list stop being comparable
  // without anything failing. `SESSIONS_RENAMED_COLUMN_IDS` maps the old spelling
  // forward so a persisted view saved under `branch` keeps its slot and its
  // hidden/shown choice.
  {
    id: SESSIONS_BRANCHES_COLUMN_ID,
    label: "Linked branches",
    width: "180px",
    gate: null,
  },
  // FEA-4210: Linked issues sits immediately after Linked branches so the two
  // linkage columns read as one group — both name artifacts this session is
  // connected to, as against the columns on either side, which describe the run
  // itself (harness, model, duration).
  {
    id: SESSIONS_ISSUES_COLUMN_ID,
    label: SESSIONS_ISSUES_COLUMN_LABEL,
    width: SESSIONS_LINKED_ENTITY_COLUMN_GRID_TRACK,
    minWidthPx: SESSIONS_LINKED_ENTITY_COLUMN_MIN_WIDTH_PX,
    gate: GRID_TABLE_V2_FLAG_KEY,
  },
  {
    id: "harness",
    label: "Harness",
    width: "124px",
    sortable: true,
    gate: null,
  },
  {
    id: "model",
    label: "Model",
    width: "160px",
    sortable: true,
    gate: null,
  },
  {
    id: "duration",
    label: "Duration",
    width: "104px",
    sortable: true,
    gate: null,
  },
  // Currency reads down a column only when the decimal points line up, so the
  // header and every cell align right (the repo's convention for numeric table
  // columns). `justify-end` lands on the flex header cell here; the body cell is
  // aligned on the grid path only, in `renderCellForGrid`.
  //
  {
    id: COST_COLUMN_ID,
    label: "Cost",
    width: `${SESSIONS_COST_COLUMN_WIDTH_PX}px`,
    sortable: true,
    className: "justify-end",
    gate: null,
  },
  // ISS-5770: Started sits immediately BEFORE Last active, the adjacency the
  // prototype specifies. It stays hidden by default — the two collapse to the
  // same coarse "3h ago" label, so showing both by default prints one fact
  // twice — but the prototype decides where it belongs when a user shows it.
  {
    id: "started",
    label: "Started",
    width: "120px",
    sortable: true,
    gate: null,
  },
  // ISS-6005: `Updated` — when the session RECORD was last mutated in the
  // database, as against `Last active` (the agent's own latest genuine
  // activity). The prototype's spec places it exactly here, between Started and
  // Last active. It ships hidden by default (see
  // SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS) — the two columns agree most of the
  // time today, and the distinction earns its track once non-activity mutations
  // (status edits, comments, tags) are common.
  //
  // The cell reads `recordUpdatedAt` — the row's own `@updatedAt`-class
  // mutation time — NOT the schema's `session_updated_at` lookalike, which is a
  // harness-reported recompute time bumped by desktop ingest and does not
  // advance on a cloud-side record mutation. See `AgentSessionListItem.
  // recordUpdatedAt` for the producer contract.
  {
    id: SESSIONS_UPDATED_COLUMN_ID,
    label: "Updated",
    width: "120px",
    sortable: true,
    gate: null,
  },
  {
    id: "lastActivity",
    label: "Last active",
    width: "120px",
    sortable: true,
    gate: null,
  },
  // ISS-5770: PR and Merge have NO slot in the prototype's 17-column spec, so
  // there is no prototype order to honour for them. Per the operator, a
  // production column the prototype omits may stay as long as it defaults OFF —
  // only `Signals` was removed outright. They trail the prototype-ordered
  // columns so they cannot disturb that sequence, stay one click away in the
  // View menu, and stay reorderable, so a persisted view carrying them keeps its
  // slots.
  {
    id: "pr",
    label: "PR",
    width: "148px",
    gate: null,
  },
  {
    id: "merge",
    label: "Merge",
    width: "116px",
    gate: null,
  },
] as const satisfies readonly SessionsColumnSpec[];

/**
 * ISS-5315: the data columns the Sessions list starts with hidden.
 *
 * PR and Merge are hidden because the ticket asks for it AND because the renamed
 * "Linked branches" cell now carries both facts in its tooltip — hiding them
 * removes a column, not a claim. Started is hidden because it collapses to the
 * same coarse "3h ago" label as Last active, which stays visible (the same call
 * the prototype makes).
 *
 * A user can still show any of them from the View menu, and a persisted view
 * that already hid or showed a column keeps the user's choice: this is only the
 * seed for a view that has never been saved, and for "Reset view".
 */
export const SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS: readonly string[] = [
  "pr",
  "merge",
  "started",
  // ISS-6005: `Updated` ships OFF by default at operator direction — it earns
  // its keep once comments/tags/status edits are common; until then it mostly
  // repeats Last active. Note the hidden-set seed below only reaches a
  // never-saved view: an EXISTING saved view's `hiddenColumns` is restored
  // verbatim, and the shared hook derives visibility as columnIds MINUS that
  // set — so a new id absent from a persisted set would AUTO-SHOW. The
  // hidden-columns saved-view migration (`migrateSavedHiddenColumns`) is what
  // keeps this column — and EVERY other id in this set (ISS-6065) — hidden for
  // persisted views; a guard test in `sessions-saved-view-migration.test.ts`
  // fails if an id is added here without a migration step naming it.
  SESSIONS_UPDATED_COLUMN_ID,
  // ISS-5770: the prototype ships `projects` and `issues` default-OFF, so they
  // leave the default-visible set. This is NOT redundant with their `gate`:
  // the gate answers "may this build render the column at all", the hidden set
  // answers "does a brand-new view start with it shown". Without this, flipping
  // `grid-table-v2` on would grow two columns the prototype's default view does
  // not have, which is the drift this ticket exists to close.
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_ISSUES_COLUMN_ID,
];

/**
 * FEA-4021: every data column in canonical natural order. A reorder of the
 * currently-visible subset merges back into THIS list so a hidden column keeps
 * its remembered slot instead of jumping to the end when re-shown; ISS-4890's
 * one-time relocation resolves a column's canonical neighbours against it too.
 * `autonomy` is included so a persisted order that reorders it survives, even
 * though it is not in the toggleable columns menu.
 *
 * Derived from {@link SESSIONS_COLUMN_SPECS} rather than re-declared, so the
 * order the table RENDERS and the order a persisted view is reconciled against
 * are the same list by construction.
 */
export const SESSIONS_DATA_COLUMN_ORDER: readonly string[] =
  SESSIONS_COLUMN_SPECS.map((spec) => spec.id);

/**
 * ISS-4890 (wongk + stage review): each data column's track width in px, keyed
 * by id.
 *
 * The saved-view migration needs to answer "would putting Cost HERE leave it
 * past {@link SESSIONS_LEGIBLE_COLUMN_BUDGET_PX}?", which is arithmetic over
 * track widths — and a relative anchor alone cannot answer it, because the
 * anchor may itself sit past the fold in a user's arrangement. Derived from
 * {@link SESSIONS_COLUMN_SPECS} rather than re-declared so a column's width has
 * exactly one definition; an id absent from here contributes nothing, which is
 * the right degradation for an id this build no longer renders.
 *
 * Almost every spec width is a plain `<n>px` literal, so parsing is a
 * `parseFloat`; a non-parseable width would degrade to 0, understating the
 * budget rather than throwing. ISS-5282 introduced the first FLEXIBLE track
 * (`minmax(140px, 0.5fr)`), whose `parseFloat` is `NaN` — silently worth 0px
 * here, which would understate every arrangement containing it and let the
 * migration place a relocated column further right than it can actually be
 * seen. Such a spec declares `minWidthPx` and it is read in preference, so the
 * arithmetic keeps measuring the track FLOOR: the width the column is guaranteed
 * at the narrowest surface the grid renders, which is the only width a
 * legibility budget can honestly be computed against.
 */
export const SESSIONS_COLUMN_WIDTH_PX: Readonly<Record<string, number>> =
  Object.fromEntries(
    SESSIONS_COLUMN_SPECS.map((spec) => [
      spec.id,
      // `in` rather than `spec.minWidthPx`: the `as const` that gives
      // SessionsColumnId its literal ids also narrows each spec to its own exact
      // shape, so the optional field is absent from the union members that omit
      // it. The read is otherwise unchanged — declared floor first, literal
      // width second, 0 for a track neither can measure.
      "minWidthPx" in spec
        ? spec.minWidthPx
        : Number.parseFloat(spec.width) || 0,
    ])
  );

/**
 * ISS-5713: the ONE derivation of "which columns does this build actually
 * render", given the flag state and the hidden-column set.
 *
 * This is the field the ticket asks for. Before it, gatedness was a property of
 * `SessionsTable`'s render path only, so {@link SESSIONS_COLUMN_SPECS} declared
 * what COULD render while every consumer needing what DOES render kept its own
 * hand-maintained exclusion list — `e2e/sessions-list-surface.spec.ts` grew a
 * `FLAG_GATED_COLUMN_IDS` literal for exactly that reason, and a PR that added
 * two gated columns broke all five of that spec's tests without touching the
 * file. A consumer now asks the question and gets an answer that cannot drift,
 * because one place knows.
 *
 * `enabledGates` is a per-key map rather than a boolean so adding a second gate
 * key later does not change this signature or silently re-interpret an existing
 * caller's argument.
 *
 * The `hostSuppliedColumnIds` seam is deliberately separate from the gate: a
 * column can be shut because the BUILD has its flag off, or because THIS MOUNT
 * cannot supply the cell (the agent-detail Sessions tab supplies no linked
 * entities). Those are different questions with different answers per mount, and
 * collapsing them onto one flag is what grows a column of em dashes on a surface
 * whose producer never emits the field.
 */
/**
 * ISS-5713: columns whose cell content the presentational table cannot derive on
 * its own — the host must wire a render seam or the column is dropped along with
 * its grid track.
 *
 * Declared HERE, beside the specs, so the render path and every derived consumer
 * read one set. It is deliberately distinct from a column's `gate`: the gate is a
 * property of the BUILD (is the flag on), this is a property of the MOUNT (does
 * this surface hold the data). Both fields behind `Owning project` and `Linked
 * issues` are cloud-only, so a locally-fed Sessions list must not grow two
 * columns of em dashes just because a flag flipped. A column listed here and
 * gated renders only when BOTH answer yes.
 */
export const SESSIONS_SEAM_REQUIRED_COLUMN_IDS: ReadonlySet<string> = new Set([
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_ISSUES_COLUMN_ID,
]);

/**
 * The minimum a column has to state for {@link selectOfferableSessionColumns} to
 * judge it. Structural rather than `SessionsColumnSpec` so the derivation can be
 * exercised against a HYPOTHETICAL column gated behind a key this build does not
 * declare yet — which is the only way to prove the rule generalises past the two
 * gated columns that happen to exist today.
 */
export type GatedSessionColumn = { id: string; gate: string | null };

/**
 * ISS-5713 / ISS-5770: the ONE answer to "may this build + this mount offer this
 * column at all", independent of whether the user has it hidden.
 *
 * Both consumers of gatedness go through here — {@link resolveRenderedSessionColumnIds}
 * (what the TABLE renders) and `sessionsToggleableColumns` (what the VIEW MENU
 * offers). They previously answered it separately, and the menu's copy was a
 * hand-maintained `projects`/`issues` exclusion list rather than a read of
 * `spec.gate`: a column added behind any other gate would have compiled, stayed
 * hidden in the table, and shown a dead switch in the menu — the same
 * declaration-versus-consumer drift this ticket exists to remove, surviving in
 * the one path it had not been applied to.
 *
 * Generic in the spec type so callers get their own element type back (labels
 * included) rather than a widened one.
 */
export function selectOfferableSessionColumns<T extends GatedSessionColumn>(
  specs: readonly T[],
  {
    enabledGates,
    hostSuppliedColumnIds,
  }: {
    enabledGates: Readonly<Record<string, boolean | undefined>>;
    hostSuppliedColumnIds?: readonly string[];
  }
): readonly T[] {
  const hostSupplied = new Set(
    (hostSuppliedColumnIds ?? []).map(normalizeSessionColumnId)
  );
  return specs.filter((spec) => {
    // `null` is the ungated sentinel (see `SessionsColumnSpec["gate"]`), so a
    // gate string that this build has not enabled shuts the column — for EVERY
    // gate key, not just the one the linked-entity pair happens to use.
    if (spec.gate !== null && !enabledGates[spec.gate]) {
      return false;
    }
    // The host filter applies ONLY to seam-required columns. Applied to every
    // column it would mean "a caller that names no seams renders no table",
    // which is the opposite of the default this helper needs.
    return !(
      SESSIONS_SEAM_REQUIRED_COLUMN_IDS.has(spec.id) &&
      !hostSupplied.has(spec.id)
    );
  });
}

export function resolveRenderedSessionColumnIds({
  enabledGates,
  hiddenColumnIds = SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS,
  hostSuppliedColumnIds,
}: {
  enabledGates: SessionsColumnGateState;
  hiddenColumnIds?: readonly string[];
  hostSuppliedColumnIds?: readonly string[];
}): readonly string[] {
  const hidden = new Set(hiddenColumnIds.map(normalizeSessionColumnId));
  return selectOfferableSessionColumns(SESSIONS_COLUMN_SPECS, {
    enabledGates,
    ...(hostSuppliedColumnIds ? { hostSuppliedColumnIds } : {}),
  })
    .filter((spec) => !hidden.has(spec.id))
    .map((spec) => spec.id);
}

/**
 * ISS-5770: the columns a brand-new Sessions view shows, in render order — the
 * prototype's ten default-ON columns.
 *
 * Derived from the declaration plus the default-hidden set rather than typed out
 * again, so this cannot state a set the table does not render. Gates are treated
 * as OFF here because that is the production default (`grid-table-v2` ships
 * off), which makes this exactly what a new user sees.
 */
export const SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS: readonly string[] =
  resolveRenderedSessionColumnIds({ enabledGates: {} });

/**
 * Every Sessions data-column id, as a literal union.
 *
 * ISS-5713: `SESSIONS_COLUMN_SPECS` is declared `as const satisfies readonly
 * SessionsColumnSpec[]` rather than annotated `: readonly SessionsColumnSpec[]`,
 * which is what makes this union possible — an annotation would widen every
 * `id` to `string` and this type with it. The `satisfies` still enforces the
 * spec shape, so the required `gate` field keeps failing `tsc` for a column that
 * does not state one; the `as const` only stops the ids being forgotten.
 *
 * Consumers that used to hand-maintain a parallel id list now derive from this,
 * so a column added to the declaration cannot be missed by one of them.
 */
export type SessionsColumnId = (typeof SESSIONS_COLUMN_SPECS)[number]["id"];

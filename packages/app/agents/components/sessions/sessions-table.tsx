"use client";

import type { SessionProvenance } from "@repo/api/src/types/branch";
import { GRID_TABLE_V2_FLAG_KEY } from "@repo/api/src/types/grid-table-v2-flag";
import { SessionStatusBadge } from "@repo/app/agents/components/session-status-badges";
import {
  SessionAutonomyChip,
  SessionHarnessChip,
  SessionModelChip,
} from "@repo/app/agents/components/sessions/session-cell-chips";
import { SESSION_GROUP_ICONS } from "@repo/app/agents/components/sessions/session-group-icons";
import { SessionProvenanceChip } from "@repo/app/agents/components/sessions/session-provenance-chip";
import {
  buildSessionGroups,
  SESSION_GROUP_COLUMN_ID,
  SessionGroupBy,
} from "@repo/app/agents/lib/session-grouping";
import {
  SESSION_REPOSITORY_MALFORMED_TOOLTIP,
  SESSION_REPOSITORY_UNKNOWN_LABEL,
  type SessionRepositoryDisplay,
  SessionRepositoryDisplayKind,
} from "@repo/app/agents/lib/session-repository-label";
import type { SessionSyncPresentation } from "@repo/app/agents/lib/session-sync-presentation";
import {
  resolveRenderedSessionColumnIds,
  SESSIONS_AUTONOMY_COLUMN_ID,
  SESSIONS_BRANCHES_COLUMN_ID,
  SESSIONS_COLUMN_SPECS,
  SESSIONS_COST_COLUMN_ID,
  SESSIONS_DATA_COLUMN_ORDER,
  SESSIONS_EXTRA_COLUMN_GRID_TRACK,
  SESSIONS_EXTRA_COLUMN_ID,
  SESSIONS_ISSUES_COLUMN_ID,
  SESSIONS_LEAD_GRID_TRACK,
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_STATUS_COLUMN_ID,
} from "@repo/app/agents/lib/sessions-table-columns";
import { CommentAvatar } from "@repo/app/shared/components/comment-avatar";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  GRID_TABLE_V2_FEATURE_FLAG_KEY,
  SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  buildGridTableCardFields,
  GridEmptyValue,
  GridTable,
  GridTableCard,
  type GridTableColumn,
  type GridTableMode,
} from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import {
  mergeColumnOrder,
  orderColumns,
  withMissingColumnsAtCanonicalSlots,
} from "@repo/design-system/lib/column-order";
import {
  FolderGit2Icon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { CostAvailability } from "../../lib/cost-availability";
import {
  columnIdToSessionSortKey,
  sessionSortKeyToColumnId,
} from "../../lib/session-sort-group";
import { SessionCostCell } from "./session-cost-cell";

/**
 * Presentational, data-agnostic sessions table shared across surfaces (web
 * `apps/app`, desktop renderer). Callers map their own session records to
 * `SessionTableRow` (display-ready strings) and supply `renderName` to wrap the
 * session name in their platform's navigation element — a `<Link>` on the web,
 * a `<button onClick={openSession}>` on desktop. The "Autonomy" column renders
 * the session's autonomy score (FEA-2094); rows without a value show an empty
 * placeholder.
 */

export type SessionTableRow = {
  id: string;
  name: string;
  /**
   * Owner/runner of the session. `null` when no identity is available.
   *
   * `id` is the owner's IDENTITY and `name` is only how we spell it: two
   * different people can share a display name, so anything that groups or
   * de-duplicates owners keys on the id (#4480 review). Optional because a
   * projection that has only a name still renders the cell correctly.
   */
  user?: { id?: string; name: string; avatarUrl?: string | null } | null;
  status: string;
  /**
   * ISS-4774 / ISS-4846 / ISS-5036 / ISS-5279: how this row's transport state
   * modulates the Status pill. Set by the shared row mapper
   * (`toSessionTableRowWithSyncFold`) only when the row's DISPLAYED run status
   * is Active; otherwise absent, so the Status cell renders the plain run status
   * exactly as before. (ISS-5366 retired the `sessions-status-pill-sync-state`
   * gate that used to be the other half of that condition.)
   *
   * It changes neither {@link status} NOR the pill's label. ISS-4848 stacked a
   * second "Syncing" pill beside the run-status one; ISS-5036 replaced the
   * run-status pill with it and moved liveness to a dot in the Name cell.
   * ISS-5279 does neither: the lifecycle word stays and sync rides on the pill's
   * presentation — a pulse, a tooltip, an accessible name. One pill, no dot, and
   * the Status column now reads the same value the Status facet filtered on and
   * the server-side Status sort ranked.
   */
  syncPresentation?: SessionSyncPresentation;
  harness: string;
  /** Producer-owned display branch for the session, if available. */
  branch?: string | null;
  /** Display-ready pull requests associated with this session. */
  pullRequests: {
    numberLabel: string;
    statusLabel: string;
    title: string;
    label: string;
  }[];
  /** Compact PR column label, or `null` when there are no associated PRs. */
  pullRequestSummaryLabel: string | null;
  /** Compact merge-state column label, or `null` when there are no PRs. */
  mergeStatusLabel: string | null;
  repo?: string | null;
  /**
   * ISS-4996: WHY {@link repo} has no label. Absent (no Git remote ever
   * resolved — the ordinary case, and the same fact as a null branch) renders
   * the shared em-dash empty glyph; malformed (a repository value WAS stored
   * but carries no identity) keeps the distinct word "Unknown".
   *
   * ISS-5366 retired the `sessions-honest-unknown-states` gate, and
   * `resolveSessionRepositoryDisplay` always returns a kind, so every shipping
   * row carries this. It stays optional only for hand-written row literals in
   * stories and tests, which render the ABSENT glyph — what a real row with no
   * repository renders — rather than a state of their own.
   */
  repositoryDisplay?: SessionRepositoryDisplay;
  model?: string | null;
  /**
   * FEA-4186: the Duration cell label, or `null` when the session has no
   * resolvable start bound — the cell then renders the shared `GridEmptyValue`
   * em-dash like every other optional column, rather than a raw hyphen string.
   */
  durationLabel: string | null;
  costLabel: string;
  costTooltip?: string | null;
  costAvailability: CostAvailability;
  /**
   * ISS-4996: the Started cell label, or `null` when the session has no
   * resolvable start time — the cell then renders the shared `GridEmptyValue`
   * em-dash like every other optional column, rather than its own raw dash
   * string at a different size and opacity. Same treatment as `durationLabel`.
   */
  startedLabel: string | null;
  /**
   * PLN-1034: rendered most-recent-genuine-activity time; the default sort.
   * ISS-4996: `null` when there is no resolvable activity time — see
   * {@link startedLabel}.
   */
  lastActivityLabel: string | null;
  /**
   * ISS-6005: the `Updated` cell label — when the session RECORD was last
   * mutated in the database (`recordUpdatedAt`), as against
   * {@link lastActivityLabel} (the agent's own latest genuine activity).
   * Optional + nullable: absent or `null` (a version-skewed producer that does
   * not serve the field, or a hand-written story/test row) renders the shared
   * `GridEmptyValue` em dash — never a borrowed lookalike timestamp.
   */
  updatedLabel?: string | null;
  /** Autonomy score 0–100 (FEA-2094); `null`/absent when no metric is available. */
  autonomy?: number | null;
  /**
   * FEA-3575: session origin (`agent`/`bot`) surfaced as a lead chip so bot and
   * agent-driven runs are distinguishable from human work. Absent/`human` rows
   * render no chip (see `SessionProvenanceChip`).
   */
  provenance?: SessionProvenance | null;
};

// ISS-4890: the column geometry — the canonical data-column order and every
// track width — lives in the dependency-light `sessions-table-columns` module so
// the persisted-view migration can resolve a column's canonical slot against the
// SAME list this table renders by, without pulling this component graph into the
// view-state hook. Locally aliased so the render code below reads unchanged.
const COLUMN_SPECS = SESSIONS_COLUMN_SPECS;
const ALL_DATA_COLUMN_IDS = SESSIONS_DATA_COLUMN_ORDER;

export function SessionsTable({
  items,
  renderName,
  extraColumnLabel,
  renderExtraColumn,
  renderProjects,
  renderIssues,
  visibleColumns,
  sortBy,
  sortDir,
  onSort,
  columnOrder,
  onColumnOrderChange,
  showProvenanceChip = false,
  mode,
  groupBy = SessionGroupBy.None,
  showGroupCount = false,
}: {
  items: SessionTableRow[];
  /**
   * Wrap the session name in the platform's navigation element. `className`
   * carries the name styling; apply it to the returned link/button.
   */
  renderName: (row: SessionTableRow, className: string) => ReactNode;
  /**
   * Optional trailing column (e.g. org-monitoring "Artifact"/"State"). When a
   * label is supplied the grid grows one track and renders `renderExtraColumn`
   * per row; otherwise the table is identical to the base layout.
   */
  extraColumnLabel?: string;
  renderExtraColumn?: (row: SessionTableRow) => ReactNode;
  /**
   * ISS-5770: render the session's provenance chip (`Agent` / `Bot`) beside the
   * name. Defaults to FALSE — the Sessions LISTING keeps the lead cell to the
   * session name and nothing else.
   *
   * This replaces the inverted `!renderQualifiers` reading that the removed
   * `Signals` column used to drive, and it is an explicit prop rather than an
   * inferred one on purpose. ISS-5666 cleared the lead cell across three repeats
   * of the same ask, so "does a pill render beside the name" must be a decision
   * a mount states out loud, not a side effect of which other seams it happened
   * to wire. The agent-detail Sessions tab opts in, because there the chip is
   * the only place that signal has ever had; the Sessions list does not.
   */
  showProvenanceChip?: boolean;
  /**
   * FEA-4209 / FEA-4210: render the linked-PROJECT(s) cell and the linked-ISSUES
   * cell.
   *
   * Seams for the same reason `renderQualifiers` is one: this table is
   * presentational and receives display-ready `SessionTableRow`s, while both
   * derivations need the raw session record (`item.project`,
   * `item.linkedArtifacts`) and, for issues, the surface's own route builder.
   * The host that already holds those records supplies them, so web and desktop
   * render from one composition.
   *
   * Absent → the column is not rendered at all. That is load-bearing, not
   * defensive: both fields are projected by the CLOUD list only, so a host that
   * cannot supply them (the desktop Sessions list, whose local producer emits
   * neither) never grows a track of em dashes. See
   * {@link SESSIONS_ISSUES_COLUMN_ID}.
   */
  renderProjects?: (
    row: SessionTableRow,
    options: Readonly<{ uncapped?: boolean }>
  ) => ReactNode;
  renderIssues?: (
    row: SessionTableRow,
    options: Readonly<{ uncapped?: boolean }>
  ) => ReactNode;
  /** When provided, only these data-column ids render (autonomy always shows). */
  visibleColumns?: Set<string>;
  /** Column-header sorting — wire all three to enable clickable sort headers. */
  sortBy?: string | null;
  sortDir?: SortDirection;
  onSort?: (column: string, direction: SortDirection) => void;
  /**
   * FEA-4021: drag-to-reorder / keyboard-reorder for the DATA columns. Pass the
   * persisted order (data-column ids) + a change handler; the trailing `extra`
   * column stays pinned at the end and never reorders. Absent → static headers.
   */
  columnOrder?: readonly string[];
  onColumnOrderChange?: (nextOrder: string[]) => void;
  /**
   * FEA-3865: layout mode forwarded to `GridTable`. Defaults to `auto` — a card
   * list below the `md` container width, the grid at `md+`. Callers rarely set
   * this; it exists to pin one layout (and to let tests exercise a single mode).
   */
  mode?: GridTableMode;
  /**
   * ISS-5315: the View menu's "Group by" dimension. The body renders one
   * section header per band followed by that band's rows.
   *
   * #4480 review: the banding, the band icon AND the grouped column's removal
   * are all derived HERE, from this one prop, rather than by each adapter — the
   * web adapter used to delete the grouped column in its page while the desktop
   * one forwarded `visibleColumns` untouched, so Group by Status banded the
   * rows on both surfaces and then repeated the Status badge down every desktop
   * row. Built by `buildSessionGroups` over the rows ALREADY on screen — see
   * that module for why a band never carries a count.
   */
  groupBy?: SessionGroupBy;
  /**
   * Show each band's row count in its header. Defaults to FALSE here: the
   * Sessions list is server-paginated, so a bare number beside "Active" reads as
   * the population when it only ever counts this page (#4480 review).
   */
  showGroupCount?: boolean;
}) {
  // ISS-4890/4906/4901: one key gates the whole fold legibility pass. Read
  // OPTIONALLY so a mount site without a flag provider (Storybook, the
  // mini-table tests) resolves it OFF and renders the prior behavior, rather
  // than crashing the subtree.
  const foldLegibilityEnabled = useFeatureFlagEnabledOptional(
    SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY
  );
  // ISS-4779 closed-by-default: the GridTable v2 header presentation (the
  // hover-revealed sort caret, the decoupled resize strip, the drag fade) is
  // OFF until this flag is on. Read here — the one component BOTH Sessions
  // adapters funnel into — and read OPTIONALLY, so the same key gates web
  // (PostHog) and the desktop renderer (its Labs toggle) together and a mount
  // with no flag provider resolves OFF instead of throwing. Without this gate
  // the restyle would land on every table that renders `TableGridHeader`
  // (Branches, Agents, Routines, Packs, Documents, Compliance) the moment it
  // merged, on both surfaces.
  const gridTableV2Enabled = useFeatureFlagEnabledOptional(
    GRID_TABLE_V2_FEATURE_FLAG_KEY
  );
  // #4480: ONE place decides that the banded column is not also printed in every
  // row. Both adapters reach this component, so neither has to remember it — and
  // the removal applies even with no `visibleColumns` supplied, because the band
  // header states that value either way.
  const groupedColumnId = SESSION_GROUP_COLUMN_ID[groupBy];
  // FEA-4006: Owner is a shown-by-default column (matching the agent-detail mock)
  // rather than a per-surface injection. With no `visibleColumns` the full
  // default set — including Owner — renders; a supplied set drives show/hide,
  // with Autonomy always kept (it is not in the toggleable menu).
  //
  // ISS-5770 REMOVED the `Signals` column outright: it exists nowhere in the
  // Sessions prototype, and the operator's decision is that the list matches the
  // prototype's column set. The row-state vocabulary it carried is not lost —
  // `Awaiting input` is projected into the Status column as `Waiting`
  // (`session-status-projection.ts`, FEA-4301), an actively-uploading row's sync
  // state folds into the Status pill (ISS-4774), and the transcript-freshness
  // verdict remains on Session Detail's Properties panel, and the cloud-sync
  // disclosure ("Local only" and friends) was MOVED onto that same Sync row by
  // this ticket — `cloudSyncState` had no other render site, so leaving it in
  // the removed column would have deleted the fact rather than relocated it.
  //
  // Do NOT answer its removal by putting the chips back beside the session name.
  // ISS-5666 cleared that cell across three repeats of the same ask, and its own
  // comment named re-rendering a pill there as the exact bug it exists to kill.
  // ISS-5713: which columns this build+mount can render is asked of the SHARED
  // derivation, not re-decided here. This block used to hand-write the gate
  // predicate, which put a second copy of the rule in the render path — the
  // exact declaration-versus-consumer split the ticket exists to close, and one
  // that would silently diverge the day a second gate key is added.
  const hostSuppliedColumnIds: string[] = [];
  if (renderProjects) {
    hostSuppliedColumnIds.push(SESSIONS_PROJECTS_COLUMN_ID);
  }
  if (renderIssues) {
    hostSuppliedColumnIds.push(SESSIONS_ISSUES_COLUMN_ID);
  }
  // `hiddenColumnIds: []` because default visibility is NOT this component's
  // job — a caller's `visibleColumns` drives show/hide, and it is applied by
  // `isSessionColumnRendered` just below. This call answers only "may this
  // column render at all here".
  const renderableColumnIds = new Set(
    resolveRenderedSessionColumnIds({
      enabledGates: { [GRID_TABLE_V2_FLAG_KEY]: Boolean(gridTableV2Enabled) },
      hiddenColumnIds: [],
      hostSuppliedColumnIds,
    })
  );
  const candidateSpecs = COLUMN_SPECS.filter((spec) =>
    renderableColumnIds.has(spec.id)
  );
  // #4480's `isSessionColumnRendered` decides the rest: it drops whichever column
  // is currently banded (so the grouped value is not reprinted in every row) and
  // exempts Autonomy, which is not in the toggleable menu and so can never appear
  // in a caller-supplied `visibleColumns`.
  const visibleDataSpecs = candidateSpecs.filter((spec) =>
    isSessionColumnRendered(spec.id, visibleColumns, groupedColumnId)
  );
  // FEA-4021: reorder the visible DATA specs by the persisted `columnOrder`, so
  // a column AND its grid track move together. The trailing `extra` spec is
  // appended AFTER and never reorders.
  //
  // ISS-5282: the persisted order is first resolved against the canonical one.
  // `orderColumns` alone emits the persisted ids and appends anything they
  // predate at the END, so a `columnOrder` saved before this build — which is
  // every saved view that exists, since they all predate the Signals column —
  // would push the new column to the far right of a table that already overflows
  // by ~1,000px, i.e. off screen, for exactly the users who have ever dragged a
  // header (review cid 3731452653). Resolving first lands it beside the columns
  // it belongs with, in the user's own arrangement, without touching the
  // relative order of anything they did arrange.
  //
  // Done at RENDER rather than as a saved-view migration on purpose: it needs no
  // storage write, no schema version, and — unlike the ISS-4890 migration, which
  // is gated behind `sessions-grid-fold-legibility` — it cannot be silently
  // skipped because some other flag is off. The next reorder persists the
  // resolved order anyway, via `mergeColumnOrder` over the complete id list.
  const dataSpecs = orderColumns(
    visibleDataSpecs,
    columnOrder &&
      withMissingColumnsAtCanonicalSlots(ALL_DATA_COLUMN_IDS, columnOrder)
  );
  const specs = [
    ...dataSpecs,
    ...(extraColumnLabel
      ? [
          {
            id: SESSIONS_EXTRA_COLUMN_ID,
            label: extraColumnLabel,
            width: SESSIONS_EXTRA_COLUMN_GRID_TRACK,
          },
        ]
      : []),
  ];
  const columns: GridTableColumn[] = specs.map(
    ({ width, ...column }) => column
  );
  const gridTemplateColumns = [
    // ISS-5770: one lead track again. The narrower chip-free floor existed only
    // to PAY for the `Signals` track inside SESSIONS_LEGIBLE_COLUMN_BUDGET_PX;
    // with that column gone there is nothing to buy, so the lead keeps its full
    // 300px floor and the session name gets the room back.
    SESSIONS_LEAD_GRID_TRACK,
    ...specs.map((spec) => spec.width),
  ].join(" ");
  const renderCellForCard = (columnId: string, row: SessionTableRow) => {
    if (columnId === SESSIONS_EXTRA_COLUMN_ID) {
      return renderExtraColumn?.(row) ?? null;
    }
    // FEA-4209 / FEA-4210: same card/grid split as the qualifiers cell above —
    // the card body wraps and is the surface below the breakpoint, so it shows
    // every chip rather than hiding links behind an overflow affordance a phone
    // has to reach for.
    if (columnId === SESSIONS_PROJECTS_COLUMN_ID) {
      return renderProjects?.(row, { uncapped: true }) ?? null;
    }
    if (columnId === SESSIONS_ISSUES_COLUMN_ID) {
      return renderIssues?.(row, { uncapped: true }) ?? null;
    }
    return renderSessionCell(columnId, row);
  };
  // The grid and the narrow card share one cell renderer so the two can never
  // disagree on a value — but they must NOT share alignment. Right-aligning
  // Cost is a grid-only concern (it exists so the decimals line up down a
  // column); a card body is a stacked key/value list with no column to align
  // to, and pushing the value to the far edge there would just look broken. So
  // the alignment is applied on the way into the grid, leaving the card path
  // byte-identical. Wrapping is safe here because `isEmptyCellValue` — which
  // drops empty columns from the card — only ever inspects the CARD renderer's
  // output, so the `GridEmptyValue` sentinel stays detectable where it matters.
  const renderCellForGrid = (columnId: string, row: SessionTableRow) => {
    if (columnId === SESSIONS_PROJECTS_COLUMN_ID) {
      return renderProjects?.(row, {}) ?? null;
    }
    if (columnId === SESSIONS_ISSUES_COLUMN_ID) {
      return renderIssues?.(row, {}) ?? null;
    }
    const content = renderCellForCard(columnId, row);
    if (columnId !== SESSIONS_COST_COLUMN_ID) {
      return content;
    }
    return <span className="flex w-full justify-end">{content}</span>;
  };
  // FEA-4021: the header can only reorder the columns it renders — the visible
  // subset. Persisting that subset as the whole order would drop a hidden
  // column's remembered position (showing it again would append it at the end).
  // Merge the reordered visible ids back into the COMPLETE data order (every
  // `COLUMN_SPECS` id) so hidden columns keep their slot. Wrapped only when the
  // caller wired a change handler.
  const handleColumnOrderChange = onColumnOrderChange
    ? (visibleOrder: string[]) =>
        onColumnOrderChange(mergeColumnOrder(ALL_DATA_COLUMN_IDS, visibleOrder))
    : undefined;
  return (
    <GridTable
      cardRender={(row, cardColumns) => (
        <SessionCard
          columns={cardColumns}
          renderCell={renderCellForCard}
          renderName={renderName}
          row={row}
          showProvenanceChip={showProvenanceChip}
        />
      )}
      columnOrder={dataSpecs.map((spec) => spec.id)}
      columns={columns}
      enhancedHeaderInteractions={gridTableV2Enabled}
      // ISS-4889: this table overflows by ~1,000px, so the fold is its normal
      // state, not an edge case; snapping it to a whole column is what makes the
      // ISS-4788 invariant structural rather than a function of column order.
      // ISS-4906: hold the fitted template still through a continuous window
      // resize and re-fit once it stops, so the columns after the widened lead
      // no longer step sideways at every fit threshold the drag crosses. Zero
      // when the flag is off ⇒ `GridTable` re-fits on every measurement, exactly
      // as ISS-4889 shipped it.
      foldFitSettleMs={
        foldLegibilityEnabled ? SESSIONS_FOLD_FIT_SETTLE_MS : NO_FOLD_FIT_SETTLE
      }
      getRowId={(row) => row.id}
      gridTemplateColumns={gridTemplateColumns}
      groupIcon={SESSION_GROUP_ICONS[groupBy]}
      groups={buildSessionGroups(items, groupBy)}
      items={items}
      // ISS-5315: "Session", per the prototype — the column holds the session's
      // AI-generated title, which is its name, so the second word said nothing.
      leadingLabel="Session"
      mode={mode}
      onColumnOrderChange={handleColumnOrderChange}
      // FEA-4300: bridge the Owner column id (`owner`) to its server sort key
      // (`user`) so a header click round-trips to the API and the active
      // indicator lights the Owner header.
      onSort={
        onSort
          ? (column, direction) =>
              onSort(columnIdToSessionSortKey(column), direction)
          : undefined
      }
      renderCell={renderCellForGrid}
      renderLead={(row) => (
        <span className="flex min-w-0 items-center gap-1.5">
          {renderName(
            row,
            "truncate font-medium text-foreground text-sm group-hover:underline"
          )}
          {/* ISS-5770: the lead cell is the session name and nothing else on
              the Sessions LISTING, which is what the prototype's own lead cell
              renders and what ISS-5666 cleared it to across three repeats of
              the ask. `showProvenanceChip` defaults to false, so removing the
              `Signals` column does NOT hand the name cell a pill back.

              The agent-detail Sessions tab opts IN, because there the
              provenance chip is the only place the "this run was not started
              by a human" signal has ever had, and dropping it outright would be
              a silent verdict drop. */}
          {showProvenanceChip ? (
            <SessionProvenanceChip provenance={row.provenance} />
          ) : null}
        </span>
      )}
      showGroupCount={showGroupCount}
      snapFoldToColumns
      sortBy={sessionSortKeyToColumnId(sortBy ?? null)}
      sortDir={sortDir}
    />
  );
}

// Status leads the card header (a badge under the name), so it is not repeated
// in the key/value body. Every other column (including the optional `extra` data
// column) stays in the body.
const CARD_HEADER_COLUMN_IDS = new Set([SESSIONS_STATUS_COLUMN_ID]);

/**
 * Narrow-surface card for one session row (FEA-3865). Header: session name +
 * provenance chip + status badge. Body: the same visible data columns the grid
 * shows, rendered as a key/value list via the table's own `renderCell` so the
 * card and the row never drift.
 *
 * Exported as the feature's `<Feature>Card` companion (FEA-3872) so an RN
 * adapter can render one session as a card without pulling in the grid path.
 */
export function SessionCard({
  row,
  columns,
  renderCell,
  renderName,
  showProvenanceChip = true,
}: {
  row: SessionTableRow;
  columns: readonly GridTableColumn[];
  renderCell: (columnId: string, row: SessionTableRow) => ReactNode;
  renderName: (row: SessionTableRow, className: string) => ReactNode;
  /**
   * ISS-5666: `false` once this mount can render qualifiers at all, so the card
   * header does not repeat a chip its own `Signals` field lists — and, when the
   * user hides that field, does not resurrect one beside the name. Keyed on the
   * SEAM for the same reason the grid lead is. Defaults to the FEA-3575 behavior
   * for a caller that renders a card on its own.
   */
  showProvenanceChip?: boolean;
}): ReactNode {
  const fields = buildGridTableCardFields(
    columns,
    CARD_HEADER_COLUMN_IDS,
    renderCell,
    row
  );
  return (
    <GridTableCard
      fields={fields}
      header={
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            {/* ISS-5666: the card is the same Sessions row stacked, so it
                mirrors the grid lead exactly — name-only wherever the `Signals`
                field carries provenance, and the FEA-3575 chip retained on a
                mount that renders no such field, so the card never drops a
                signal the grid keeps. */}
            <span className="flex min-w-0 items-center gap-1.5">
              {renderName(row, "truncate font-medium text-foreground text-sm")}
              {showProvenanceChip ? (
                <SessionProvenanceChip provenance={row.provenance} />
              ) : null}
            </span>
            <SessionStatusBadge
              status={row.status}
              syncPresentation={row.syncPresentation}
            />
          </div>
        </div>
      }
    />
  );
}

function renderSessionCell(columnId: string, row: SessionTableRow): ReactNode {
  switch (columnId) {
    case SESSIONS_STATUS_COLUMN_ID:
      return (
        <SessionStatusBadge
          status={row.status}
          syncPresentation={row.syncPresentation}
        />
      );
    case "owner":
      return renderOwnerCell(row.user ?? null);
    case "autonomy":
      // ISS-6005: the prototype's colored tier pill; the numeric score moves
      // into the tooltip (`Autonomy score N of 100`) and no longer prints in
      // the cell. The empty sentinel stays HERE, not inside the component, so
      // `isEmptyCellValue` keeps seeing the shared glyph by element type.
      return row.autonomy == null ? (
        <GridEmptyValue />
      ) : (
        <SessionAutonomyChip autonomy={row.autonomy} />
      );
    case "repo":
      return renderRepoChip(row.repo ?? null, row.repositoryDisplay);
    case SESSIONS_BRANCHES_COLUMN_ID:
      return renderLinkedBranchesCell(row);
    case "pr":
      return renderPullRequestChip(row);
    case "merge":
      return renderMergeStatus(row.mergeStatusLabel);
    case "harness":
      // ISS-6005: the prototype's neutral outlined pill — name only, no tinted
      // tone. `HarnessBadge` (the tinted ToneBadge) stays for the surfaces the
      // prototype does not respecify.
      return <SessionHarnessChip harness={row.harness} />;
    case "model":
      // ISS-6005: provider-colored dot + model id; tooltip content per the
      // prototype (`<provider> · <model>`), Radix mechanism per production.
      return row.model ? (
        <SessionModelChip model={row.model} />
      ) : (
        <GridEmptyValue />
      );
    case "duration":
      return row.durationLabel ? (
        <span className="text-muted-foreground text-sm tabular-nums">
          {row.durationLabel}
        </span>
      ) : (
        <GridEmptyValue />
      );
    case "cost":
      // ISS-5840: plain text, no pill. The chip was keyed on the row having a
      // TOOLTIP, not on the cost — see `SessionCostCell` for the `$1.01` case.
      //
      // The no-usage dash is returned DIRECTLY here rather than from inside
      // `SessionCostCell`: `isEmptyCellValue` identifies an empty cell by
      // element TYPE (`value.type === GridEmptyValue`), so a component wrapping
      // the sentinel is opaque to it and the narrow-card body would stop
      // dropping the Cost row. Same split as `LocPerDollarColumnValue`, whose
      // own `—` branch is likewise story-only because its table returns the
      // shared sentinel first.
      return row.costAvailability === CostAvailability.NoUsage ? (
        <GridEmptyValue />
      ) : (
        <SessionCostCell
          availability={row.costAvailability}
          label={row.costLabel}
          tooltip={row.costTooltip}
        />
      );
    case "started":
      return renderTimestampCell(row.startedLabel);
    case "updated":
      // ISS-6005: record-mutation recency. Same compact one-line treatment as
      // its timestamp peers (the ISS-5813 no-wrap rule); absent — a
      // version-skewed producer that does not serve `recordUpdatedAt` — renders
      // the shared empty glyph rather than borrowing a lookalike timestamp.
      return renderTimestampCell(row.updatedLabel ?? null);
    case "lastActivity":
      return renderTimestampCell(row.lastActivityLabel);
    default:
      return null;
  }
}

function renderOwnerCell(user: SessionTableRow["user"]): ReactNode {
  if (!user) {
    return <GridEmptyValue />;
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <CommentAvatar
        author={user.name}
        authorAvatar={user.avatarUrl}
        size="xs"
      />
      <span className="truncate text-sm" title={user.name}>
        {user.name}
      </span>
    </span>
  );
}

/**
 * FEA-3644: the shared truncate-with-tooltip chip used by the repo/branch/PR/model
 * cells. Each of those columns can carry a long value that must clip to an
 * ellipsis inside a fixed grid track and surface the full value on hover/focus.
 * Centralizing the Tooltip → Chip scaffold keeps the focus ring, sizing, and
 * a11y wiring (interactive + keyboard-reachable tooltip) identical across cells;
 * per-cell variation is limited to the optional leading icon, the mono span, and
 * the tooltip's own class (e.g. PR's pre-line multi-line list).
 */
function renderTooltipChip({
  icon,
  label,
  tooltip,
  mono = false,
  tooltipClassName = "max-w-xs break-words",
}: {
  icon?: ReactNode;
  label: ReactNode;
  tooltip: ReactNode;
  mono?: boolean;
  tooltipClassName?: string;
}): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Chip
          className={icon ? "min-w-0 gap-1" : "min-w-0"}
          interactive
          tabIndex={0}
          variant="outline"
        >
          {icon}
          <span className={mono ? "truncate font-mono" : "truncate"}>
            {label}
          </span>
        </Chip>
      </TooltipTrigger>
      <TooltipContent className={tooltipClassName}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function renderRepoChip(
  label: string | null,
  display?: SessionRepositoryDisplay
): ReactNode {
  if (!label) {
    // ISS-4996: an ABSENT repository is the same fact as an absent branch, so it
    // gets the same shared empty glyph the Branch column right beside it uses.
    // Rendering the word "Unknown" here made one condition wear two glyphs in
    // adjacent columns, and put a value-shaped label in a column whose facet has
    // no "Unknown" option to select it back — a label the filter can never
    // reach. A MALFORMED value (stored, but carrying no identity) is a different
    // fact and keeps the distinct word, because that row is a data-quality
    // signal that should stay visible rather than disappear into the em dash.
    //
    // FEA-4274 chose "Unknown" partly to keep the Repository row present in the
    // narrow-width card layout, where `isEmptyCellValue` drops em-dash rows.
    // Dropping it there is now the intended behavior: it is exactly what the
    // Branch, Model, and PR cells already do for the same condition, so the card
    // stops listing a row whose only content is "we have nothing".
    //
    // This deliberately does NOT change the session-detail Properties row, which
    // keeps spelling out "Unknown" (`detail-content.ts`,
    // `agent-session-detail-view.tsx`). That is not the FEA-4274 divergence
    // coming back: FEA-4274 was a TRUTH divergence — detail invented a
    // filesystem path for a session the list called Unknown. Both surfaces here
    // make the identical claim ("no remote resolved") and differ only in how
    // densely they say it, the same way this grid's other optional columns use a
    // dash while their detail rows use words. A grid cell has room for a glyph;
    // a labelled property row has room for the word.
    // #4324 review: keeping the word is only defensible if a reader can decode
    // it. Two glyphs in one column, one of them a bare word, is otherwise a
    // puzzle for anyone outside the team — so the malformed cell carries a
    // tooltip AND an accessible name saying what it means. (The reviewer's
    // alternative, routing this to a log instead, is not available on this side
    // of the wire: `no-client-debug-logging` bans logging from client modules,
    // and this is a `"use client"` grid cell. Monitoring the condition belongs
    // to the producer that stored the value, not to the render.)
    if (display?.kind === SessionRepositoryDisplayKind.Malformed) {
      // Uses the SAME tooltip-chip the RESOLVED cell in this column uses, rather
      // than a hand-rolled span. A bare `aria-label` on a plain `<span>` is not
      // supported by its implicit role (and a `tabIndex` on one is a
      // non-interactive focus stop), so this is both the accessible answer and
      // the consistent one: every cell in this column that HAS something to say
      // says it the same way. No icon — there is no repository to point at.
      return renderTooltipChip({
        label: SESSION_REPOSITORY_UNKNOWN_LABEL,
        tooltip: SESSION_REPOSITORY_MALFORMED_TOOLTIP,
      });
    }
    // ISS-5366: everything that is not MALFORMED renders the shared empty
    // glyph, including a row that carries no `display` at all. `resolveSession
    // RepositoryDisplay` always returns a kind, so with the gate retired every
    // shipping row resolves one and an absent `display` is unreachable in
    // production — it survives only in row literals written by hand (stories,
    // tests). Those used to fall through to a plain muted "Unknown" span, which
    // made the story the one place rendering a state the product can no longer
    // produce. Folding the fallback into the ABSENT glyph means a hand-written
    // row now shows exactly what a real one shows.
    return <GridEmptyValue />;
  }
  return renderTooltipChip({
    icon: <FolderGit2Icon className="size-3 shrink-0" />,
    label,
    tooltip: label,
  });
}

/**
 * ISS-5315: the "Linked branches" cell. Renders the session's branch exactly as
 * the old "Branch" column did, and folds the row's PR summary and merge state
 * into the SAME tooltip.
 *
 * That fold is what makes hiding the separate PR and Merge columns by default
 * honest: the grid states one fact fewer per row at rest, but no fact is lost —
 * every one of them is still one hover/focus away in the cell they belong to,
 * and both columns remain one click away in the View menu. A row with no branch
 * still renders the shared empty glyph rather than a chip labelled with a PR.
 *
 * #4480: the three facts are three LINES, and only the branch is monospaced. A
 * branch name in mono is right — it is a literal ref you might retype. A PR
 * summary and a merge state are not code, and setting all three in mono joined
 * by a dot turned "main · #412 open · Merged" into what read as one code string.
 */
function renderLinkedBranchesCell(row: SessionTableRow): ReactNode {
  const label = row.branch ?? null;
  if (!label) {
    return <GridEmptyValue />;
  }
  const notes = [row.pullRequestSummaryLabel, row.mergeStatusLabel].filter(
    (part): part is string => Boolean(part)
  );
  return renderTooltipChip({
    icon: <GitBranchIcon className="size-3 shrink-0" />,
    label,
    mono: true,
    tooltip: (
      <span className="flex flex-col gap-0.5">
        <span className="break-words font-mono">{label}</span>
        {notes.map((note) => (
          <span key={note}>{note}</span>
        ))}
      </span>
    ),
  });
}

function renderPullRequestChip(row: SessionTableRow): ReactNode {
  if (!row.pullRequestSummaryLabel) {
    return <GridEmptyValue />;
  }
  const tooltipLabel = row.pullRequests
    .map((pr) => `${pr.numberLabel} ${pr.statusLabel} · ${pr.title}`)
    .join("\n");
  return renderTooltipChip({
    icon: <GitPullRequestIcon className="size-3 shrink-0" />,
    label: row.pullRequestSummaryLabel,
    mono: true,
    tooltip: tooltipLabel,
    tooltipClassName: "max-w-xs whitespace-pre-line break-words",
  });
}

function renderMergeStatus(label: string | null): ReactNode {
  if (!label) {
    return <GridEmptyValue />;
  }
  return (
    <Chip className="min-w-0 gap-1" variant="outline">
      <GitMergeIcon className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </Chip>
  );
}

/**
 * ISS-4906: how long the Sessions grid's measured container width must hold
 * still before the whole-column fold fit is recomputed.
 *
 * Sized to sit just past the gap between consecutive `ResizeObserver` frames of
 * a window drag (so a drag in progress never re-fits) while staying under the
 * threshold at which a settle reads as a delayed response rather than a
 * settling one. Short enough that letting go of the window edge snaps the fold
 * to its boundary as part of the same gesture.
 */
const SESSIONS_FOLD_FIT_SETTLE_MS = 150;

/**
 * The `foldFitSettleMs` value that means "do not settle" — `GridTable` then
 * re-fits on every measurement, the ISS-4889 behavior the flag-off path keeps.
 * Named rather than inlined as a bare `0` so the off branch says what it does.
 */
const NO_FOLD_FIT_SETTLE = 0;

/**
 * Does a data column render, given the caller's visible-column set and the
 * column currently banded by "Group by"?
 *
 * Three rules, in order (#4480): the banded column never renders — its band
 * header already states that value for every row beneath it — Autonomy always
 * does (it is not in the toggleable menu), and everything else follows the
 * caller's set, or the full default order when the caller supplied none.
 */
function isSessionColumnRendered(
  columnId: string,
  visibleColumns: Set<string> | undefined,
  groupedColumnId: string | undefined
): boolean {
  if (columnId === groupedColumnId) {
    return false;
  }
  if (columnId === SESSIONS_AUTONOMY_COLUMN_ID) {
    return true;
  }
  return visibleColumns ? visibleColumns.has(columnId) : true;
}

/**
 * A relative-time cell renderer.
 */
function renderTimestampCell(label: string | null): ReactNode {
  if (!label) {
    return <GridEmptyValue />;
  }
  return <span className="text-muted-foreground text-sm">{label}</span>;
}

"use client";

import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { SessionStatusBadge } from "@repo/app/agents/components/session-status-badges";
import { SESSION_GROUP_ICONS } from "@repo/app/agents/components/sessions/session-group-icons";
import { SessionProvenanceChip } from "@repo/app/agents/components/sessions/session-provenance-chip";
import { useSessionGroups } from "@repo/app/agents/hooks/use-session-groups";
import {
  SESSION_GROUP_COLUMN_ID,
  SessionGroupBy,
} from "@repo/app/agents/lib/session-grouping";
import type {
  SessionsSeamCellRenderer,
  SessionTableRow,
} from "@repo/app/agents/lib/session-list-row";
import { resolveRenderedSessionColumnIds } from "@repo/app/agents/lib/sessions-column-visibility";
import {
  SESSIONS_AUTONOMY_COLUMN_ID,
  SESSIONS_COLUMN_SPECS,
  SESSIONS_COST_COLUMN_ID,
  SESSIONS_DATA_COLUMN_ORDER,
  SESSIONS_EXTRA_COLUMN_GRID_TRACK,
  SESSIONS_EXTRA_COLUMN_ID,
  SESSIONS_ISSUES_COLUMN_ID,
  SESSIONS_LEAD_GRID_TRACK,
  SESSIONS_LEGACY_UNSORTABLE_COLUMN_IDS,
  SESSIONS_PRIORITY_COLUMN_ID,
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_STATUS_COLUMN_ID,
  SESSIONS_TAGS_COLUMN_ID,
} from "@repo/app/agents/lib/sessions-table-columns";
import {
  TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_LABELS,
  TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_WIDTH_PX,
} from "@repo/app/agents/lib/sessions-total-estimated-cost-columns";
import { ProductGridTableV2 } from "@repo/app/shared/components/product-grid-table-v2";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  buildGridTableCardFields,
  GridTableCard,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import type { GridTableV2Mode } from "@repo/design-system/components/ui/grid-table-v2";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  mergeColumnOrder,
  orderColumns,
  withMissingColumnsAtCanonicalSlots,
} from "@repo/design-system/lib/column-order";
import type { ReactNode } from "react";
import { useRef } from "react";
import {
  columnIdToSessionSortKey,
  sessionSortKeyToColumnId,
} from "../../lib/session-sort-group";
import { renderSessionCell } from "./session-cell-renderers";
import { useSessionStatusColumnWidth } from "./use-session-status-column-width";

/**
 * Presentational, data-agnostic sessions table shared across surfaces (web
 * `apps/app`, desktop renderer). Callers map their own session records to
 * `SessionTableRow` (display-ready strings) and supply `renderName` to wrap the
 * session name in their platform's navigation element — a `<Link>` on the web,
 * a `<button onClick={openSession}>` on desktop. The "Autonomy" column renders
 * the session's autonomy score (FEA-2094); rows without a value show an empty
 * placeholder.
 */

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
  renderTags,
  renderPriority,
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
  renderProjects?: SessionsSeamCellRenderer;
  renderIssues?: SessionsSeamCellRenderer;
  /**
   * ISS-8712: the `Tags` cell — the org tag picker for this row's Session
   * artifact.
   *
   * A seam for a different reason than the pair above. Those are seams because
   * the DATA is cloud-only; this one is a seam because the cell WRITES: it owns
   * apply/remove mutations and a query for the org's tag vocabulary. Mounting
   * that inside this presentational table would make a query provider a
   * requirement of every bare `render(<SessionsTable />)` — the "shared
   * component newly calls a provider-requiring hook" break, applied to its own
   * test suite and to Storybook.
   *
   * Absent → the column and its track are dropped, same as the pair above.
   */
  renderTags?: (row: SessionTableRow) => ReactNode;
  /**
   * ISS-10332: the `Priority` cell — the champion editor over this row's
   * Session artifact. A seam for the reason `renderTags` is one (the cell
   * WRITES, through the host's data source) and for a second: only a source
   * that projects the field can fill it. Absent → the column and its track are
   * dropped, so a locally-fed list never grows a column of em dashes.
   */
  renderPriority?: (row: SessionTableRow) => ReactNode;
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
   * FEA-3865: layout mode forwarded to `ProductGridTableV2`. Defaults to `auto` — a card
   * list below the `md` container width, the grid at `md+`. Callers rarely set
   * this; it exists to pin one layout (and to let tests exercise a single mode).
   */
  mode?: GridTableV2Mode;
  /**
   * ISS-5315: the toolbar's "Group by" dimension (the Group menu since
   * ISS-10361 retired the View menu). The body renders one
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
  const sessionGroups = useSessionGroups(items, groupBy);
  const universalArtifactStatusEnabled = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  // ISS-8712: read at the point the column is swapped on, not threaded in from a
  // host — the same discipline the gate above follows, and what keeps ONE read
  // site per flag. Optional, so a mount with no PostHog provider (the desktop
  // renderer, Storybook, a bare test render) resolves OFF rather than throwing.
  // That is also the whole desktop story for this feature: the gate is web-side
  // by operator directive, and the desktop simply never sees it turn on.
  const artifactTagsEnabled = useFeatureFlagEnabledOptional(
    SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY
  );
  const columnLabels = TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_LABELS;
  const statusRegionRef = useRef<HTMLDivElement>(null);
  const statusWidth = useSessionStatusColumnWidth(statusRegionRef);
  const columnWidths: Readonly<Record<string, number>> = {
    ...TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_WIDTH_PX,
    [SESSIONS_STATUS_COLUMN_ID]: Math.max(
      TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_WIDTH_PX[SESSIONS_STATUS_COLUMN_ID],
      statusWidth
    ),
  };
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
  // Do NOT answer its removal by putting the CHIPS back beside the session name.
  // ISS-5666 cleared that cell across three repeats of the same ask, and its own
  // comment named re-rendering a pill there as the exact bug it exists to kill.
  // FEA-4204 added the one flagged exception — a comment count, which restates no
  // other column — in `SyncedSessionsTable`'s `renderName`, where its reasoning
  // is written out. It is not a precedent for relocating a row-state chip.
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
  if (renderTags) {
    hostSuppliedColumnIds.push(SESSIONS_TAGS_COLUMN_ID);
  }
  if (renderPriority) {
    hostSuppliedColumnIds.push(SESSIONS_PRIORITY_COLUMN_ID);
  }
  // `hiddenColumnIds: []` because default visibility is NOT this component's
  // job — a caller's `visibleColumns` drives show/hide, and it is applied by
  // `isSessionColumnRendered` just below. This call answers only "may this
  // column render at all here".
  const renderableColumnIds = new Set(
    resolveRenderedSessionColumnIds({
      enabledGates: {
        [SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY]: Boolean(artifactTagsEnabled),
      },
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
  // storage write and no schema version. The next reorder persists the resolved
  // order anyway, via `mergeColumnOrder` over the complete id list.
  const dataSpecs = orderColumns(
    visibleDataSpecs,
    columnOrder &&
      withMissingColumnsAtCanonicalSlots(ALL_DATA_COLUMN_IDS, columnOrder)
  ).map((spec) => ({
    ...spec,
    label: columnLabels[spec.id] ?? spec.label,
    width: `${columnWidths[spec.id]}px`,
  }));
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
  // ISS-8190: the canonical spec enables Autonomy sorting for the flagged v2
  // surface. This legacy table is also mounted by flag-off web and Desktop,
  // whose local sorter cannot honor that key, so withhold that capability at
  // their shared projection boundary — from the NAMED set, so the next surface
  // that projects these specs finds the rule rather than inheriting a sortable
  // header for free.
  const columns: GridTableColumn[] = specs.map(({ width, ...column }) =>
    SESSIONS_LEGACY_UNSORTABLE_COLUMN_IDS.has(column.id)
      ? { ...column, sortable: false }
      : column
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
    if (columnId === SESSIONS_TAGS_COLUMN_ID) {
      return renderTags?.(row) ?? null;
    }
    if (columnId === SESSIONS_PRIORITY_COLUMN_ID) {
      return renderPriority?.(row) ?? null;
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
    <div className="contents" ref={statusRegionRef}>
      <ProductGridTableV2
        cardCompatibility={{
          alwaysActive: true,
          render: (row, cardColumns) => (
            <SessionCard
              columns={cardColumns}
              renderCell={renderCellForCard}
              renderName={renderName}
              row={row}
              showProvenanceChip={showProvenanceChip}
              showStatus={
                !(
                  universalArtifactStatusEnabled &&
                  groupedColumnId === SESSIONS_STATUS_COLUMN_ID
                )
              }
            />
          ),
        }}
        columnOrder={dataSpecs.map((spec) => spec.id)}
        columns={columns}
        // ISS-4889: this table overflows by ~1,000px, so the fold is its normal
        // state, not an edge case; snapping it to a whole column is what makes the
        // ISS-4788 invariant structural rather than a function of column order.
        // ISS-4906: hold the fitted template still through a continuous window
        // resize and re-fit once it stops, so the columns after the widened lead
        // no longer step sideways at every fit threshold the drag crosses. Zero
        foldFitSettleMs={SESSIONS_FOLD_FIT_SETTLE_MS}
        getRowId={(row) => row.id}
        gridTemplateColumns={gridTemplateColumns}
        groupIcon={SESSION_GROUP_ICONS[groupBy]}
        groups={sessionGroups}
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
            {/* ISS-5770: this presentational table puts the session name and
              nothing else in the lead cell, which is what the prototype's own
              lead cell renders and what ISS-5666 cleared it to across three
              repeats of the ask. `showProvenanceChip` defaults to false, so
              removing the `Signals` column does NOT hand the name cell a pill
              back.

              FEA-4204's comment-count tag is NOT rendered here. It composes into
              the `renderName` a caller passes (`SyncedSessionsTable`), so this
              component keeps the rule and the one flagged exception lives with
              the caller that owns the data it reads.

              The agent-detail Sessions tab opts IN, because there the
              provenance chip is the only place the "this run was not started
              by a human" signal has ever had, and dropping it outright would be
              a silent verdict drop. */}
            {showProvenanceChip ? (
              <SessionProvenanceChip provenance={row.provenance} />
            ) : null}
          </span>
        )}
        showGroupCounts={showGroupCount}
        snapFoldToColumns
        sortBy={sessionSortKeyToColumnId(sortBy ?? null)}
        sortDir={sortDir}
        staticTableSemantics
      />
    </div>
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
  headerAction,
  renderCell,
  renderName,
  showProvenanceChip = true,
  showStatus = true,
}: {
  row: SessionTableRow;
  columns: readonly GridTableColumn[];
  headerAction?: ReactNode;
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
  /**
   * False when the surrounding group header already states this row's status.
   * A merely hidden Status column still keeps the header badge.
   */
  showStatus?: boolean;
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
        <div className="flex items-start justify-between gap-2">
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
            {showStatus ? (
              <SessionStatusBadge
                artifactId={row.id}
                status={row.status}
                syncPresentation={row.syncPresentation}
              />
            ) : null}
          </div>
          {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
        </div>
      }
    />
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
export const SESSIONS_FOLD_FIT_SETTLE_MS = 150;

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

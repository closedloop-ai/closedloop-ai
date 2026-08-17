"use client";

import { Chip } from "@repo/design-system/components/ui/chip";
import {
  buildGridTableCardFields,
  GridEmptyValue,
  GridTable,
  GridTableCard,
  type GridTableColumn,
  type GridTableMode,
  ROW_ACTIONS_COLUMN,
  ROW_ACTIONS_COLUMN_ID,
} from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import {
  COLLAPSE_EMPTY,
  type CollapseCellKey,
  collapseConstantColumns,
} from "@repo/design-system/lib/collapse-columns";
import {
  applyColumnWidths,
  MIN_COLUMN_WIDTH_PX,
  mergeColumnOrder,
  orderColumns,
} from "@repo/design-system/lib/column-order";
import { Link } from "@repo/navigation/link";
import {
  FolderGit2Icon,
  GitBranchIcon,
  MessageSquareIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { ProvenanceChip } from "../../shared/components/provenance-chip";
import {
  type BranchRow,
  RENDER_MISSING,
  RENDER_UNATTRIBUTED,
  shortRepoName,
} from "../lib/branch-row";
import { CHECKS_STATUS_VARIANT } from "../lib/checks-status-display";
import { ApprovedBranchesTable } from "./approved-branches-table";
import { BranchChangesBar } from "./branch-changes-bar";
import { BranchPRBadge } from "./branch-pr-badge";
import { BranchRowActionsMenu } from "./branch-row-actions-menu";
import { renderBranchStatus } from "./branch-status";

/**
 * Branches table — shared by the web `/branches` page and the desktop Branches
 * view, rendered through the design system's generic `GridTable`. The column set
 * and order match the Branches mock
 * (`apps/prototypes/app/p/branches/components/branches-table.tsx`): Name (lead),
 * Owner, Repository, Status, Last active, Linked Sessions, Changes, Pull
 * request, and Checks (FEA-4066). The agent-detail-only inline "Version" column
 * is the trailing `extra` column (data-gated; see `detail-branches-tab.tsx`).
 * GitHub-live cells degrade to the empty-value affordance when enrichment is
 * absent — never a fabricated value.
 */

const LEAD_WIDTH = "minmax(260px, 1fr)";

// Each data column carries its grid width so the columns show/hide menu (B5a)
// can drop a column AND its track in lockstep. Order mirrors the prototype's
// `BRANCH_COLUMNS`.
const OWNER_COLUMN_ID = "owner";

const COLUMN_SPECS: readonly (GridTableColumn & { width: string })[] = [
  // Owner: the branch actor. Shown by default (no feature flag); hideable via
  // the View menu like any other column. Not sortable: no server owner-sort key.
  { id: OWNER_COLUMN_ID, label: "Owner", width: "150px" },
  { id: "repo", label: "Repository", width: "160px", sortable: true },
  { id: "status", label: "Status", width: "140px", sortable: true },
  { id: "lastActivity", label: "Last active", width: "110px", sortable: true },
  { id: "sessions", label: "Linked Sessions", width: "130px", sortable: true },
  { id: "changes", label: "Changes", width: "130px", sortable: true },
  { id: "pr", label: "Pull request", width: "150px" },
  // FEA-4066: the checks rollup ("N/N passing"). Trailing position mirrors the
  // prototype's `COLUMN_SPECS`. Not sortable — like Owner and Pull request,
  // there is no server-side checks sort key, so the header stays static rather
  // than offer a sort that the BFF can't honor. The cell only renders once both
  // `checksPassed` and `checksTotal` are present; while every visible row is
  // absent the column is data-gated out entirely (see `renderBranchChecks` /
  // `hasAnyChecksRollup`).
  { id: "checks", label: "Checks", width: "120px" },
];

// FEA-4021: every data column in canonical natural order. A reorder of the
// currently-visible subset merges back into THIS list so a hidden/collapsed
// column keeps its remembered slot instead of jumping to the end when re-shown.
const ALL_DATA_COLUMN_IDS: readonly string[] = COLUMN_SPECS.map(
  (spec) => spec.id
);

// FEA-4168: each data column's natural width (px), parsed from its fixed-px
// spec. This is the base a resize adjusts from and the fallback a column with no
// persisted width renders at. Every data column here uses a fixed `Npx` width,
// so the parse is exact; a non-px track would parse to NaN and be dropped by the
// resize base's `Number.isFinite` guards.
const NATURAL_COLUMN_WIDTHS: Readonly<Record<string, number>> =
  Object.fromEntries(
    COLUMN_SPECS.map((spec) => [spec.id, Number.parseInt(spec.width, 10)])
  );

// Always-rendered row-actions column (B5c) — not toggleable, so it's appended
// after the visible data columns rather than living in COLUMN_SPECS.
const ACTIONS_SPEC: GridTableColumn & { width: string } = {
  ...ROW_ACTIONS_COLUMN,
  width: "52px",
};

type BranchRowActions = {
  onOpenDetail?: (item: BranchRow) => void;
  /**
   * FEA-4259: builds the href for the Linked Sessions count link (and the
   * row-actions menu's "View linked sessions" item) — the branch detail's
   * Sessions & timeline tab, whose swimlane lanes one row per linked session.
   * Absent (or a 0-count row) → the count renders as a plain, non-link value.
   */
  getSessionsHref?: (item: BranchRow) => string;
};

export type BranchLeadRenderInput = {
  item: BranchRow;
  className: string;
  children: ReactNode;
};

const EXTRA_COLUMN_ID = "extra";
const EXTRA_COLUMN_GRID_TRACK = "minmax(120px, 0.5fr)";

export function BranchesTable({
  items,
  visibleColumns,
  extraColumnLabel,
  renderExtraColumn,
  getBranchHref,
  renderBranchLink,
  onOpenDetail,
  getSessionsHref,
  sortBy,
  sortDir,
  onSort,
  columnOrder,
  onColumnOrderChange,
  columnWidths,
  onColumnWidthChange,
  mode,
  approved = false,
  allRows,
  tagsReadOnly = false,
}: {
  items: BranchRow[];
  /** When provided, only these data-column ids render (B5a columns show/hide). */
  visibleColumns?: Set<string>;
  /**
   * Optional trailing column (e.g. the agent-detail "Version" column). When a
   * label is supplied the grid grows one track (before the actions column) and
   * renders `renderExtraColumn` per row; otherwise the table is unchanged.
   */
  extraColumnLabel?: string;
  renderExtraColumn?: (item: BranchRow) => ReactNode;
  /**
   * Additive (Epic C2): when provided, the Name lead is wrapped in an anchor to
   * the branch detail route. Absent → a plain (non-link) lead, so the list works
   * before Branch Detail (Epic C) lands.
   */
  getBranchHref?: (item: BranchRow) => string;
  /**
   * Platform-owned branch lead renderer. Web injects Next Link; desktop can keep
   * the href fallback for hash navigation without importing platform adapters.
   */
  renderBranchLink?: (input: BranchLeadRenderInput) => ReactNode;
  /** Row-actions menu (B5c): Open-detail hidden unless provided (Epic C1 gate). */
  onOpenDetail?: (item: BranchRow) => void;
  /**
   * FEA-4259: when provided, the Linked Sessions count on a row with 1+ sessions
   * renders as a link to `getSessionsHref(item)` — the branch detail's Sessions &
   * timeline tab, whose swimlane lanes one row per linked session. The row-actions
   * menu's "View linked sessions" item links to the same href. Absent → a plain
   * count and no menu item. A 0-count row is always a plain empty-value
   * affordance (never a dead link).
   */
  getSessionsHref?: (item: BranchRow) => string;
  /** Column-header sorting — wire all three to enable clickable sort headers. */
  sortBy?: string | null;
  sortDir?: SortDirection;
  onSort?: (column: string, direction: SortDirection) => void;
  /**
   * FEA-4021: drag-to-reorder / keyboard-reorder for the DATA columns. Pass the
   * persisted order (data-column ids) + a change handler; the trailing `extra`
   * and `actions` columns stay pinned at the end and never reorder. Absent →
   * static headers.
   */
  columnOrder?: readonly string[];
  onColumnOrderChange?: (nextOrder: string[]) => void;
  /**
   * FEA-4168: drag-to-resize / keyboard-resize for the DATA columns. Pass the
   * persisted per-column widths (px, keyed by id) + a change handler; the
   * trailing `extra` and `actions` columns are fixed and never resize. Absent →
   * no resize handles, natural widths.
   */
  columnWidths?: Readonly<Record<string, number>>;
  onColumnWidthChange?: (columnId: string, widthPx: number) => void;
  /**
   * FEA-3865: layout mode forwarded to `GridTable`. Defaults to `auto` — a card
   * list below the `md` container width, the grid at `md+`. Callers rarely set
   * this; it exists to pin one layout (and to let tests exercise a single mode).
   */
  mode?: GridTableMode;
  /** PRD-601 fixed-schema List, dark-launched by the host. */
  approved?: boolean;
  /** Complete pre-pagination cohort for repository collision labels. */
  allRows?: BranchRow[];
  /** Cached Desktop rows expose tags read-only while offline. */
  tagsReadOnly?: boolean;
}) {
  // FEA-3968: drop a low-variance categorical column (Status/Repository/Owner)
  // that is constant across every visible row — a filled chip repeated down a
  // whole column conveys nothing. The column AND its grid track drop in lockstep
  // because the shared helper filters the id+width specs. Memoized on the inputs
  // so the O(columns × rows) scan does not re-run on unrelated re-renders.
  const dataSpecs = useMemo(() => {
    const visibleSpecs = (
      visibleColumns
        ? COLUMN_SPECS.filter((spec) => visibleColumns.has(spec.id))
        : COLUMN_SPECS
    )
      // FEA-4066: data-gate the Checks column (like the agent-detail Version
      // column) — drop it entirely when NO visible row carries a checks rollup,
      // so an all-empty column never renders a header + 120px track over a wall
      // of em-dashes. No producer emits the passed count today (web BFF sends
      // `checksPassed: null`; desktop sends both counts null), so today it is
      // always gated out; it re-materializes automatically once the count is
      // plumbed upstream. The table runs the FEA-3968 collapse with
      // `collapseEmptyColumns: false` (so a single filtered row can't drop a
      // column), which is why the empty-column drop lives here, not in
      // `branchCollapseKey`.
      .filter((spec) => spec.id !== "checks" || hasAnyChecksRollup(items));
    // Never collapse the active sort column: sorting runs before pagination, so
    // Status or Repository can go constant on the current page while the
    // persisted sort still controls which bucket shows — dropping its header
    // would strand the user with no way to reverse the sort (wongk).
    const keepColumnIds = sortBy ? new Set([sortBy]) : undefined;
    return collapseConstantColumns(
      visibleSpecs,
      items,
      branchCollapseKey,
      keepColumnIds,
      // Constant-only: a single filtered branch that merely lacks a repo/owner
      // must keep those columns; only a value repeated down 2+ rows collapses.
      { collapseEmptyColumns: false }
    );
  }, [visibleColumns, items, sortBy]);
  // FEA-4021: reorder the visible DATA specs by the persisted `columnOrder`
  // (ids not in the order keep their natural position at the end via the shared
  // helper), so a column AND its grid track move together. The trailing
  // `extra`/`actions` specs are appended AFTER and never reorder.
  const orderedDataSpecs = useMemo(
    () => orderColumns(dataSpecs, columnOrder),
    [dataSpecs, columnOrder]
  );
  // FEA-4168: fold the persisted per-column widths over each data column's
  // natural width, so a resized column renders at its saved width AND the resize
  // base (`resizedColumnWidths`) it adjusts from stays paired with its grid
  // track. `applyColumnWidths` keeps only known ids and clamps to the shared
  // floor, so a stale/too-small saved width can't strand a column. The trailing
  // `extra`/`actions` specs are fixed and excluded from resize.
  const resizedColumnWidths = useMemo(
    () =>
      applyColumnWidths(
        Object.fromEntries(
          orderedDataSpecs.map((spec) => [
            spec.id,
            NATURAL_COLUMN_WIDTHS[spec.id] ?? MIN_COLUMN_WIDTH_PX,
          ])
        ),
        columnWidths
      ),
    [orderedDataSpecs, columnWidths]
  );
  const sizedDataSpecs = orderedDataSpecs.map((spec) => ({
    ...spec,
    width: `${resizedColumnWidths[spec.id]}px`,
  }));
  const specs = [
    ...sizedDataSpecs,
    ...(extraColumnLabel
      ? [
          {
            id: EXTRA_COLUMN_ID,
            label: extraColumnLabel,
            width: EXTRA_COLUMN_GRID_TRACK,
          },
        ]
      : []),
    ACTIONS_SPEC,
  ];
  const columns: GridTableColumn[] = specs.map(
    ({ width, ...column }) => column
  );
  // The actions column is the table's final column. GridTable adds no trailing
  // border cell, so the template is just the lead + each column's track (the
  // right edge is open).
  const gridTemplateColumns = [
    LEAD_WIDTH,
    ...specs.map((spec) => spec.width),
  ].join(" ");

  // FEA-4021: the header can only reorder the columns it renders — the visible,
  // non-collapsed subset. Persisting that subset as the whole order would drop a
  // hidden/collapsed column's remembered position (showing it again would append
  // it at the end). Merge the reordered visible ids back into the COMPLETE data
  // order (every `COLUMN_SPECS` id) so hidden columns keep their slot. Wrapped
  // only when the caller wired a change handler.
  const handleColumnOrderChange = onColumnOrderChange
    ? (visibleOrder: string[]) =>
        onColumnOrderChange(mergeColumnOrder(ALL_DATA_COLUMN_IDS, visibleOrder))
    : undefined;

  if (approved) {
    return (
      <ApprovedBranchesTable
        allRows={allRows}
        getBranchHref={getBranchHref}
        getSessionsHref={getSessionsHref}
        items={items}
        onSort={onSort}
        renderBranchLink={renderBranchLink}
        sortBy={sortBy}
        sortDir={sortDir}
        tagsReadOnly={tagsReadOnly}
        visibleColumns={visibleColumns}
      />
    );
  }

  const renderCellForCard = (columnId: string, item: BranchRow) =>
    columnId === EXTRA_COLUMN_ID
      ? (renderExtraColumn?.(item) ?? null)
      : renderBranchCell(columnId, item, {
          onOpenDetail,
          getSessionsHref,
        });
  return (
    <GridTable
      cardRender={(item, cardColumns) => (
        <BranchCard
          columns={cardColumns}
          getBranchHref={getBranchHref}
          item={item}
          renderBranchLink={renderBranchLink}
          renderCell={renderCellForCard}
        />
      )}
      columnOrder={orderedDataSpecs.map((spec) => spec.id)}
      columns={columns}
      columnWidths={onColumnWidthChange ? resizedColumnWidths : undefined}
      getRowId={(item) => item.id}
      gridTemplateColumns={gridTemplateColumns}
      items={items}
      leadingLabel="Branch"
      leadingSortKey="name"
      mode={mode}
      onColumnOrderChange={handleColumnOrderChange}
      onColumnWidthChange={onColumnWidthChange}
      onSort={onSort}
      renderCell={renderCellForCard}
      renderLead={(item) =>
        renderBranchLead(item, { getBranchHref, renderBranchLink })
      }
      sortBy={sortBy}
      sortDir={sortDir}
    />
  );
}

// Status and the row-actions menu lead the card header, so they are not
// repeated in the key/value body. Every other column (including the optional
// `extra` data column) stays in the body.
const BRANCH_CARD_HEADER_COLUMN_IDS = new Set([
  "status",
  ROW_ACTIONS_COLUMN_ID,
]);

/**
 * Narrow-surface card for one branch row (FEA-3865). Header: branch name (linked
 * when the host supplies a route) + provenance chip + status chip, with the
 * row-actions menu kept reachable. Body: the same visible data columns the grid
 * shows, rendered as a key/value list via the table's own `renderCell` so the
 * card and the row never drift.
 *
 * Exported as the feature's `<Feature>Card` companion (FEA-3872) so an RN
 * adapter can render one branch as a card without pulling in the grid path.
 */
export function BranchCard({
  item,
  columns,
  renderCell,
  getBranchHref,
  renderBranchLink,
}: {
  item: BranchRow;
  columns: readonly GridTableColumn[];
  renderCell: (columnId: string, item: BranchRow) => ReactNode;
  getBranchHref?: (item: BranchRow) => string;
  renderBranchLink?: (input: BranchLeadRenderInput) => ReactNode;
}): ReactNode {
  const fields = buildGridTableCardFields(
    columns,
    BRANCH_CARD_HEADER_COLUMN_IDS,
    renderCell,
    item
  );
  // FEA-3968: honor the collapse on the card too. When Status collapsed out of
  // the grid (constant "Open" down every row) it must not resurface in the card
  // header — otherwise the column vanishes on the grid yet repeats on every
  // narrow-screen card. `columns` is the surviving set the grid passes down.
  const showStatus = columns.some((column) => column.id === "status");
  return (
    <GridTableCard
      fields={fields}
      header={
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            {renderBranchLead(item, { getBranchHref, renderBranchLink })}
            {/* Reuse the table's own cell renderer so the status chip and the
                row-actions menu (with the host's onOpenDetail handler and
                getSessionsHref already bound) are identical to the grid row.
                Omitted when Status collapsed out of the grid. */}
            {showStatus ? renderCell("status", item) : null}
          </div>
          <span className="shrink-0">
            {renderCell(ROW_ACTIONS_COLUMN_ID, item)}
          </span>
        </div>
      }
    />
  );
}

function renderBranchLead(
  item: BranchRow,
  options: {
    getBranchHref?: (item: BranchRow) => string;
    renderBranchLink?: (input: BranchLeadRenderInput) => ReactNode;
  }
): ReactNode {
  const lead = (
    <span className="flex min-w-0 items-center gap-1.5 font-medium text-sm">
      <GitBranchIcon
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="truncate font-mono">{item.branchName}</span>
      {/* Badge agent-worktree / bot provenance (informational). Human rows
          carry no chip. FEA-4004 removed the merged/agent default-hide, so these
          rows always render — the chip just explains the origin. */}
      <ProvenanceChip provenance={item.provenance} />
      {/* Comment count is a soft Epic F3 consumer — null until that lands. */}
      {item.commentCount != null && item.commentCount > 0 ? (
        <Chip className="gap-1" variant="muted">
          <MessageSquareIcon aria-hidden className="size-3" />
          {item.commentCount}
        </Chip>
      ) : null}
    </span>
  );

  if (options.renderBranchLink) {
    return options.renderBranchLink({
      item,
      className: "min-w-0 hover:underline",
      children: lead,
    });
  }

  if (options.getBranchHref) {
    // FEA-4051: the surface-agnostic `@repo/navigation` `Link` drives the active
    // navigation adapter on both surfaces. A raw `<a href>` was a dead click on
    // the desktop renderer: its hash-store adapter does not intercept a raw
    // anchor and the Electron nav guard blocks the raw document navigation to
    // the in-app path. `Link` renders a real anchor, preserving middle/modifier
    // click and the same className/a11y. Mirrors FEA-4018's agents-table fix.
    return (
      <Link
        className="min-w-0 hover:underline"
        href={options.getBranchHref(item)}
      >
        {lead}
      </Link>
    );
  }
  return lead;
}

function renderBranchCell(
  columnId: string,
  item: BranchRow,
  actions: BranchRowActions
): ReactNode {
  switch (columnId) {
    case "repo":
      // github-live: no repo identity → missing-data, not a "—" chip.
      return item.repo === RENDER_MISSING ? (
        <GridEmptyValue />
      ) : (
        <Chip className="min-w-0 gap-1" variant="outline">
          <FolderGit2Icon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{shortRepoName(item.repo)}</span>
        </Chip>
      );
    case "status":
      return renderBranchStatus(item.status);
    case OWNER_COLUMN_ID:
      // FEA-3432: a null owner renders the shared em-dash empty-value
      // affordance (`GridEmptyValue`), consistent with the Sessions owner
      // column and the session-detail Owner property — NOT a literal
      // "unattributed" chip.
      return item.owner === RENDER_UNATTRIBUTED ? (
        <GridEmptyValue />
      ) : (
        <Chip className="min-w-0 gap-1" variant="outline">
          <UserIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{item.owner}</span>
        </Chip>
      );
    case "lastActivity":
      return (
        <span className="text-muted-foreground text-xs">
          {item.lastActivityLabel}
        </span>
      );
    case "sessions":
      return renderBranchSessions(item, actions.getSessionsHref);
    case "changes":
      return (
        <BranchChangesBar
          additions={item.additions}
          deletions={item.deletions}
        />
      );
    case "pr":
      // Return the shared empty-value sentinel directly (not wrapped in
      // BranchPRBadge, which renders it internally) so the card fallback's
      // empty-cell filter can see a no-PR row and drop the "Pull request" line
      // instead of stacking a dash. The grid renders identically — BranchPRBadge
      // returns the same GridEmptyValue for a null prNumber.
      return item.prNumber == null ? (
        <GridEmptyValue />
      ) : (
        <BranchPRBadge
          prNumber={item.prNumber}
          prState={item.prState}
          prTitle={item.prTitle}
          prUrl={item.prUrl}
          repoShortName={
            item.repo === RENDER_MISSING ? null : shortRepoName(item.repo)
          }
        />
      );
    case "checks":
      return renderBranchChecks(item);
    case ROW_ACTIONS_COLUMN_ID:
      return (
        <BranchRowActionsMenu
          getSessionsHref={actions.getSessionsHref}
          item={item}
          onOpenDetail={actions.onOpenDetail}
        />
      );
    default:
      return null;
  }
}

/**
 * FEA-4259: Linked Sessions cell. A row with 1+ sessions renders the muted
 * count chip; when `getSessionsHref` is supplied it becomes a link to the branch
 * detail's Sessions & timeline tab, whose swimlane lanes one row per linked
 * session (ordered by start), with an accessible name spelling out the
 * otherwise-bare count. The link renders through `<Chip asChild interactive>`
 * wrapping the `@repo/navigation` `Link` — the same construction as the PR badge
 * and transcript-file pills in this row, so the muted-background hover shift and
 * the tokenized focus-visible ring match the row's other linked chips instead of
 * an underline running under the icon and the browser's default focus box. The
 * surface-agnostic `Link` drives the active nav adapter on both web and desktop
 * (a raw `<a>` is a dead click on the desktop renderer; mirrors the branch lead's
 * FEA-4051 fix). A 0-count row is always the shared empty-value affordance —
 * never a dead link.
 */
function renderBranchSessions(
  item: BranchRow,
  getSessionsHref?: (item: BranchRow) => string
): ReactNode {
  if (item.sessionCount <= 0) {
    return <GridEmptyValue />;
  }
  const content = (
    <>
      <UsersIcon aria-hidden className="size-3 shrink-0" />
      {item.sessionCount}
    </>
  );
  if (!getSessionsHref) {
    return (
      <Chip className="gap-1" variant="muted">
        {content}
      </Chip>
    );
  }
  return (
    <Chip asChild className="gap-1" interactive variant="muted">
      <Link
        aria-label={`${item.sessionCount} linked session${
          item.sessionCount === 1 ? "" : "s"
        }`}
        href={getSessionsHref(item)}
      >
        {content}
      </Link>
    </Chip>
  );
}

/**
 * FEA-3968 collapse extractor: a stable per-cell key for the low-variance
 * categorical columns, so a Status/Repository/Owner column that is constant or
 * empty across every visible row collapses. Only these categorical columns
 * opt in — number columns (Sessions/Changes/Checks) and timestamps are not
 * badges and keep rendering even when uniform, and columns with no case here
 * are always kept. (FEA-4066: the all-empty Checks column is dropped by the
 * data-gate in `dataSpecs`, not here — the table runs this extractor with
 * `collapseEmptyColumns: false`, so an empty column would not collapse here.)
 */
function branchCollapseKey(columnId: string, item: BranchRow): CollapseCellKey {
  switch (columnId) {
    case "status":
      return item.status;
    case "repo":
      // Key on the DISPLAYED value (`shortRepoName`), not the full identity:
      // the cell renders `web` for both `acme/web` and `other/web`, so keying on
      // the full path would paint an identical `web` down every row yet keep the
      // column (wongk). The short name is what the user actually reads.
      return item.repo === RENDER_MISSING
        ? COLLAPSE_EMPTY
        : shortRepoName(item.repo);
    case OWNER_COLUMN_ID:
      return item.owner === RENDER_UNATTRIBUTED ? COLLAPSE_EMPTY : item.owner;
    default:
      // No extractor entry ⇒ the shared helper keeps the column unconditionally.
      return COLLAPSE_EMPTY;
  }
}

/**
 * FEA-4066: does any visible row carry a renderable checks rollup? The Checks
 * column is data-gated on this (like the agent-detail Version column) so an
 * all-empty column never renders a header + track over a wall of em-dashes. A
 * rollup is renderable only when BOTH counts are present — mirrors the
 * `renderBranchChecks` guard so the gate and the cell agree.
 */
function hasAnyChecksRollup(items: readonly BranchRow[]): boolean {
  return items.some(
    (item) => item.checksPassed != null && item.checksTotal != null
  );
}

/**
 * FEA-4066 checks rollup cell. The count only renders when BOTH `checksPassed`
 * and `checksTotal` are present — absence degrades to the shared empty-value
 * affordance, never a fabricated `0/N passing`. No producer emits the passed
 * count today (the web BFF sends `checksPassed: null` with a non-null
 * `checksTotal`; desktop sends both null), so this stays empty until the passed
 * count is plumbed upstream — the `hasAnyChecksRollup` data-gate in `dataSpecs`
 * then hides the empty column entirely. When present, the value is toned by
 * `checksStatus` so red/green/pending reads differently, not one flat gray.
 */
function renderBranchChecks(item: BranchRow): ReactNode {
  if (item.checksPassed == null || item.checksTotal == null) {
    return <GridEmptyValue />;
  }
  const variant = item.checksStatus
    ? CHECKS_STATUS_VARIANT[item.checksStatus]
    : "default";
  return (
    <ToneLabel className="tabular-nums" variant={variant}>
      {item.checksPassed}/{item.checksTotal} passing
    </ToneLabel>
  );
}

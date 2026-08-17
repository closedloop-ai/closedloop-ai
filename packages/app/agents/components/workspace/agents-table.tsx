"use client";

/**
 * Agents workspace inventory table (T-3.1).
 *
 * Sortable GridTable with columns: Name (lead), Type, Authors, Source, Harness,
 * Metric, Invocations, Sessions, Versions, Actions — the four right-flush
 * numeric columns contiguous at the end (ISS-5366). FEA-4098 (Slice 3):
 * the Owner column was removed — the Authors column now renders the authors
 * people-set (discoverer + editors) from the version's lineage. (FEA-4266
 * renamed the visible "Collaborators" label to "Authors"; the `collaborators`
 * column id is unchanged.)
 * FEA-4267: the Versions column carries the collapsed-family "N versions" count,
 * shown only on pages that have such a family (see hasVersionCountSignal).
 *
 * Badge/label helpers imported from packages/app/agents/lib/component-meta.tsx.
 * Row data and sort/select handlers come from props — no direct mock imports.
 *
 * Domain component: lives in this feature slice, NOT in @closedloop-ai/design-system.
 */

import type {
  AgentComponent,
  AgentComponentSortDir,
  AgentMetricMode,
} from "@repo/api/src/types/agent-component";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { AGENT_COMPONENT_AUTHORS_LABEL } from "@repo/app/agents/lib/agent-component-authors";
import { resolveAlwaysShowActions } from "@repo/app/shared/lib/adaptive-props";
import {
  buildGridTableCardFields,
  GridEmptyValue,
  GridTable,
  GridTableCard,
  type GridTableColumn,
  type GridTableGroup,
  type GridTableMode,
  ROW_ACTIONS_COLUMN,
  ROW_ACTIONS_COLUMN_ID,
} from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { TableGridHeaderAlign } from "@repo/design-system/components/ui/table-grid-header";
import { TooltipTrigger } from "@repo/design-system/components/ui/tooltip";
import {
  COLLAPSE_EMPTY,
  type CollapseCellKey,
  collapseConstantColumns,
} from "@repo/design-system/lib/collapse-columns";
import {
  mergeColumnOrder,
  orderColumns,
} from "@repo/design-system/lib/column-order";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { type ReactNode, useMemo } from "react";
import {
  CollaboratorStack,
  hasVersionHistoryAffordance,
  isNewlyDiscovered,
  KindLabel,
  NewDot,
  NUMBER_FORMAT,
  SourceLabel,
  StatusDot,
} from "../../lib/component-meta";
import {
  TRUNCATED_LABEL_CLASS,
  TruncatedLabelTooltip,
} from "../../lib/truncated-label-tooltip";
import { HarnessBadge } from "../session-status-badges";
import { AgentRowActionsMenu } from "./agent-row-actions-menu";
import { LocPerDollarColumnValue } from "./loc-per-dollar-cell";

// ---------------------------------------------------------------------------
// Column specs
// ---------------------------------------------------------------------------

const LEAD_WIDTH = "minmax(240px, 1fr)";

type ColumnSpec = GridTableColumn & { width: string };

/**
 * ISS-5475 (review cid 3737914561): the Metric column header's explaining
 * sentence — what LOC/$ measures and which direction is better.
 *
 * It sits on the BASE column spec (see the metric entry in
 * {@link COLUMN_SPECS}) rather than on the alignment delta, so it ships with the
 * label it explains on every render. Exported so the test covering it reads the
 * copy from here instead of restating a literal that could drift.
 */
export const LOC_PER_DOLLAR_COLUMN_TOOLTIP =
  "Lines changed per dollar spent. Higher is better.";

// FEA-4248: the lead (Name) is the only flexible `minmax(240px, 1fr)` track;
// every other column is a fixed width, so the cost of never collapsing a
// canonical column (Type/Harness/Source) lands on the lead — the track carrying
// the primary, already-truncating component name. Type and Harness only ever
// hold a short chip, so they are sized tight (96px / 120px) and hand the
// difference back to the lead rather than reserving room three constant columns
// don't use on a scoped kind tab (reviewer).
const COLUMN_SPECS: readonly ColumnSpec[] = [
  {
    id: "type",
    label: "Type",
    width: "96px",
    sortable: true,
  },
  // FEA-4098 (Slice 3): the Owner column was removed; the Authors column now
  // renders the authors people-set (discoverer + editors) from the version's
  // lineage. A people-set has no scalar sort key, so the column stays
  // unsortable. FEA-4266: the `collaborators` id is an internal state key
  // (persisted view / column order); only the visible label became "Authors".
  {
    id: "collaborators",
    label: AGENT_COMPONENT_AUTHORS_LABEL,
    width: "168px",
    sortable: false,
  },
  {
    id: "source",
    label: "Source",
    width: "196px",
    sortable: true,
  },
  {
    id: "harness",
    label: "Harness",
    width: "120px",
    sortable: true,
  },
  // ISS-5366 (review cid 3737914557): Metric leads the NUMERIC block rather than
  // sitting at position 3 between Type and Authors. Right-aligning it there left
  // its digits pressed against a left-flush text column while the three columns
  // it shares an alignment with sat right-flush at the far end of the row — the
  // same ragged read {@link ALIGNED_COUNT_COLUMN_IDS} rejects for the counts,
  // one level up. Metric / Invocations / Sessions / Versions are now contiguous,
  // so all four right-flush columns read as one block.
  //
  // Metric goes at the HEAD of that block, not after Versions: `versions` is the
  // one conditionally-rendered column here (dropped on any page with no
  // multi-version family, see the `hasVersionCountSignal` gate below), so
  // keeping it at the tail means its coming and going never shifts the x of the
  // other three between pages.
  //
  // This moves the NATURAL order, which is what a reader with no saved
  // preference gets. It does not rewrite anyone's persisted order: the stored
  // `columnOrder` defaults to `[]` (`use-persisted-table-view-state.ts`) and
  // `orderColumns` returns its input unchanged for an empty order, so a user who
  // never dragged a column picks this up on next load with no migration. A user
  // who HAS dragged one has an explicit full-order array that still wins, which
  // is the correct outcome — a stored order is a stated preference, not a stale
  // copy of the default.
  //
  // ISS-5475 (review cid 3737914561): the explaining `tooltip` rides this BASE
  // entry, not {@link POLISHED_METRIC_HEADER}. With the per-row tone deleted
  // (see `lib/component-meta.tsx`, "LOC/$ metric helpers") the header is the
  // only thing on this surface naming the unit or its direction, so it is
  // single-sourced with the label it explains rather than living in a delta
  // that exists for alignment. `headerAlign` stays in that delta — that part
  // genuinely is display polish.
  //
  // The wording deliberately does NOT say "merged". This column renders
  // `AgentComponentRow.locPerDollar`, which `apps/api/app/agent-components/
  // loc-per-dollar.ts` derives by summing `linesAdded + linesRemoved` over every
  // session that used the component and dividing by those sessions'
  // `estimatedCost` — there is no merge predicate in that path, and the field's
  // own contract in `packages/api/src/types/agent-component.ts` reads "lines
  // changed per dollar". The Sessions card's `LOC / $ (Merged)` IS merged-only
  // and keeps its own merged wording; the two populations differ, so the two
  // sentences must (ISS-5366, review cid 3737906515 / 3737914543).
  //
  // It also omits the word "sessions". Playwright's `hasText` string form is a
  // CASE-INSENSITIVE SUBSTRING match and the card-scoped locators on this metric
  // filter by identifying words like "Sessions" — #4573 failed a merge-group run
  // on exactly that. "per dollar spent" carries the population implicitly
  // without reintroducing the substring.
  {
    id: "metric",
    label: LOC_PER_DOLLAR_LABEL,
    width: "132px",
    sortable: true,
    tooltip: LOC_PER_DOLLAR_COLUMN_TOOLTIP,
  },
  {
    id: "invocations",
    label: "Invocations",
    width: "120px",
    sortable: true,
  },
  {
    id: "sessions",
    label: "Sessions",
    width: "108px",
    sortable: true,
  },
  // FEA-4267: the collapsed-family "N versions" count. Its own narrow count
  // column, NOT a trailing signal in
  // the name lead — the lead track is minmax(240px, 1fr) and the name already
  // ellipsizes at that width, so a word+number squatting there would cost the
  // primary identifier a chunk of its visible characters on exactly the family
  // rows this PR surfaces. A column also earns the narrow-surface card row for
  // free (AgentCard builds its key/value fields from the columns). Not sortable:
  // the count is present only on the subset of rows that have a version history
  // affordance, so it is not a stable whole-table ordering key.
  {
    id: "versions",
    label: "Versions",
    width: "104px",
    sortable: false,
  },
];

const ACTIONS_SPEC: ColumnSpec = {
  ...ROW_ACTIONS_COLUMN,
  width: "52px",
};

/**
 * ISS-4866: the metric column header's delta. ISS-5366 retired the
 * `agents-loc-per-dollar-display` gate to its enabled state, so this is now the
 * header every render gets. Merged over the base spec, so the id, label, width
 * and sortability stay single-sourced from {@link COLUMN_SPECS}.
 *
 * ISS-5333: `headerAlign`, not a `justify-end` in `className`. The class reached
 * the header CELL, but this column is sortable and a sortable header wraps its
 * label in a `flex-1` button that consumes the cell — so the cell had nothing
 * left to distribute and the label never moved, leaving exactly the
 * right-aligned-header-over-left-aligned-values state the line below calls worse
 * than leaving both alone. `headerAlign` applies to the cell AND that button.
 * The alignment has to be here at all because a column of one fixed precision
 * only reads as a column when the decimal points share an x; the body cells
 * right-align in lockstep via the grid renderer's `alignEnd`.
 *
 * ISS-5475 (review cid 3737914561): the `tooltip` that used to live here moved
 * onto the `metric` entry in {@link COLUMN_SPECS} — the header sentence is not
 * display polish, so it is single-sourced with the label it explains rather than
 * riding this delta. This delta is now purely the alignment.
 */
const POLISHED_METRIC_HEADER = {
  headerAlign: TableGridHeaderAlign.End,
} as const;

/**
 * ISS-4973: the three COUNT columns, right-aligned together. ISS-5366 retired
 * the `agents-count-column-alignment` gate to its enabled state, so the three
 * move together unconditionally.
 *
 * All three, not one: `Invocations` was the column the review named, but
 * right-aligning it alone would leave its two numeric neighbours ragged beside
 * it — a worse read than the ragged-but-consistent row we have now. The set is
 * exactly the columns whose value is a formatted count.
 */
const ALIGNED_COUNT_COLUMN_IDS: ReadonlySet<string> = new Set([
  "invocations",
  "sessions",
  "versions",
]);

/**
 * ISS-4973: the header delta for a right-aligned count column.
 *
 * ISS-5333: `headerAlign`, not a `justify-end` in `className` — see
 * {@link POLISHED_METRIC_HEADER}. `Versions` was the only one of these three
 * whose header ever moved, and only because it is NOT sortable: its bare-span
 * label sits directly in the cell, so the cell's own `justify-end` reached it.
 * The other two wrap their label in a `flex-1` sort button that ate the class.
 */
const ALIGNED_COUNT_HEADER = {
  headerAlign: TableGridHeaderAlign.End,
} as const;

// FEA-4021: every data column in canonical natural order. A reorder of the
// currently-visible/non-collapsed subset merges back into THIS list so a
// hidden/collapsed column keeps its remembered slot instead of jumping to the
// end when re-shown.
const ALL_DATA_COLUMN_IDS: readonly string[] = COLUMN_SPECS.map(
  (spec) => spec.id
);

// FEA-4248: canonical categorical columns kept even when constant across every
// visible row. Without this, `?kind=skill` (all skills share one Harness) would
// drop the Harness column + grid track entirely, reading as missing data and
// diverging from the other kind tabs. Exempting Type/Harness/Source keeps a
// stable column set across every tab. With Metric already protected too, no
// shipped column collapses today — the collapse machinery below is kept dormant
// for any future non-canonical column that opts in (extractor + call retained so
// opting in needs no re-wiring).
const NEVER_COLLAPSE_COLUMN_IDS: readonly string[] = [
  "type",
  "harness",
  "source",
];

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

/**
 * A count cell (Invocations / Sessions).
 *
 * ISS-4973: `alignEnd` pushes the value to the end of its grid cell (`ml-auto`
 * against the cell's flex row). `tabular-nums` alone does not stack digits —
 * every digit gets the same advance width, but left-aligned, `1,234` and `8`
 * still start at the same x, so nothing lines up. Right-aligning is the half
 * that makes the fixed widths pay. Set by the GRID renderer ONLY; the narrow
 * card renders the same value inline beside its own label, where a stretch to
 * the far edge would orphan it. ISS-5366 retired the gate but kept that seam.
 *
 * ISS-5333: `alignEnd` is honored on the UNAVAILABLE branch too. It used to be
 * applied only where a number existed, so a row with no counts rendered a stripe
 * of left-flush em-dashes under right-flush columns. Position is not value —
 * moving the dash right does not fabricate a zero, it puts the "no number" mark
 * where the reader's eye is already scanning for the number.
 */
const NumberCell = ({
  value,
  alignEnd,
}: {
  value: number | null;
  alignEnd?: boolean;
}): ReactNode =>
  value === null ? (
    <GridEmptyValue alignEnd={alignEnd} />
  ) : (
    <span className={cn("text-sm tabular-nums", alignEnd && "ml-auto")}>
      {NUMBER_FORMAT.format(value)}
    </span>
  );

// FEA-3866: the action is hover-revealed on a mouse (`group-hover:opacity-100`)
// but ALWAYS visible on a touch pointer (`touch:opacity-100`), since there is no
// hover to reveal it. `justify-end` keeps it right-aligned in the grid cell;
// `alignEnd={false}` lets the card header render it inline without the trailing
// stretch.
//
// FEA-3220: the cell now hosts the real `AgentRowActionsMenu` (Open detail /
// Copy component name) instead of the previous unwired placeholder button,
// mirroring the Branches row-actions pattern. `getComponentHref` is
// threaded through so "Open detail" navigates to the same per-component detail
// route the Name lead links to; it is omitted from the menu when no href is
// supplied.
//
// The open menu portals its content out to the body, so once the pointer moves
// onto a menu item the row loses `:hover` — without the open-state variant the
// trigger would fade to `opacity-0` while its own menu is still floating above
// an invisible kebab. Radix marks the open trigger with `data-state="open"`, so
// `has-[[data-state=open]]:opacity-100` keeps the cell fully visible for as long
// as the menu is open, independent of hover.
//
// FEA-3872: `alwaysShowActions` formalizes the RN-parity seam. A surface with no
// hover at all (React Native) passes `true` to drop the hover-reveal entirely so
// the affordance is always painted; leaving it undefined keeps the pointer-aware
// web/desktop default (`touch:` reveal on coarse pointers, hover on fine ones).
const HOVER_REVEAL_CLASS =
  "opacity-0 touch:opacity-100 transition-opacity group-hover:opacity-100 has-[[data-state=open]]:opacity-100";

const ActionsCell = ({
  component,
  getComponentHref,
  alignEnd = true,
  alwaysShowActions,
}: {
  component: AgentComponent;
  getComponentHref?: (item: AgentComponent) => string;
  alignEnd?: boolean;
  alwaysShowActions?: boolean;
}): ReactNode => (
  <div
    className={cn(
      "flex items-center",
      resolveAlwaysShowActions(alwaysShowActions) ? null : HOVER_REVEAL_CLASS,
      alignEnd && "w-full justify-end"
    )}
  >
    <AgentRowActionsMenu getComponentHref={getComponentHref} item={component} />
  </div>
);

// ---------------------------------------------------------------------------
// Metric cell — the LOC/$ column
// ---------------------------------------------------------------------------
//
// NOT driven by `metricMode`, despite the prop of that name still threading
// through this component's props. ISS-4667 removed the inverted $/KLOC mode and
// ISS-4866 removed the picker that selected between the survivors; ISS-5366 then
// retired that gate, so the mode is no longer settable from any surface. The
// prop and its persisted view dimension are left in place deliberately (a saved
// view still carries them, and the ISS-4667 legacy-value migration still maps
// them), but nothing here reads one.

const MetricCell = ({
  component,
  alignEnd,
}: {
  component: AgentComponent;
  /**
   * True on the grid row, where the polished column right-aligns so its one
   * fixed precision actually lines the decimals up. False/absent on the narrow
   * card, which renders this value inline beside the Type chip.
   */
  alignEnd?: boolean;
}): ReactNode => {
  const value = component.locPerDollar;
  // ISS-5333: every arm of this cell honors `alignEnd` — the null branch returns
  // BEFORE the value render, and leaving it unaligned once produced a left-flush
  // dash under right-flush numbers. Header, real values, and the unavailable
  // dash move together or not at all.
  if (value === null) {
    // The unavailable dash follows the column's alignment, same as `NumberCell`.
    // Deliberately still the SHARED `GridEmptyValue` sentinel and not
    // `<LocPerDollarColumnValue value={null} />` (which the ticket suggested):
    // `isEmptyCellValue` identifies an empty cell by element TYPE, and the
    // narrow card drops empty body rows on that test — returning a different
    // component here would grow every card a literal "Metric —" line.
    //
    // ISS-5475: that emptiness is NOT observable from the cell's call site.
    // `renderCell` hands back `<MetricCell …>` and this sentinel appears only
    // once the component renders, so `isEmptyCellValue` on the returned node
    // reports non-empty for a null row. `AgentCard`'s header, which does need to
    // know, reads `locPerDollar` directly rather than testing the node.
    return <GridEmptyValue alignEnd={alignEnd} />;
  }
  // ISS-4866: no `metricMode` switch. ISS-4667 removed the inverted $/KLOC mode,
  // leaving a two-arm switch whose arms returned the identical node — a per-mode
  // transform that no longer transformed. The metric has ONE unit and ONE
  // orientation (LOC/$, higher is better) on every surface; when a second mode
  // earns a different computation it brings its own branch back, along with the
  // picker this ticket also retires.
  return <LocPerDollarColumnValue alignEnd={alignEnd} value={value} />;
};

// ---------------------------------------------------------------------------
// Live activity dot (FEA-3179)
// ---------------------------------------------------------------------------

/**
 * A component whose most recent ACTUAL invocation (`lastInvokedAt`) falls within
 * this many milliseconds of "now" is treated as currently-active and gets the
 * animated "live" dot in the Name lead cell. 60 minutes — long enough that an
 * in-progress or just-finished session still reads as live, short enough to
 * distinguish it from stale rows.
 */
const ACTIVE_RECENCY_WINDOW_MS = 60 * 60 * 1000;

/**
 * True when the component's real last-invocation time is within the active
 * window of now.
 *
 * FEA-3179 keys off `lastInvokedAt` (max usage `lastInvokedAt` from the service),
 * NOT `lastSeenAt`: `lastSeenAt` is an inventory-observation time the pack
 * scanner refreshes to `now()` on every sync for every still-installed
 * component, so keying off it would light the dot for EVERY installed component
 * — a meaningless signal (same root cause as the FEA-3160 windowing bug). When
 * `lastInvokedAt` is absent (no usage rows, e.g. configured-only kinds, or a
 * surface like desktop that does not project it), the component is never treated
 * as active and no dot renders.
 */
function isRecentlyActive(lastInvokedAt: string | undefined): boolean {
  if (!lastInvokedAt) {
    return false;
  }
  const invoked = Date.parse(lastInvokedAt);
  if (Number.isNaN(invoked)) {
    return false;
  }
  return Date.now() - invoked <= ACTIVE_RECENCY_WINDOW_MS;
}

/**
 * Subtle animated dot marking a component as active in the last hour. FEA-3620
 * routes it through the shared {@link StatusDot} primitive (primary tone) so it
 * and the "newly discovered" dot are literally the same component with different
 * tones — one dot vocabulary, no duplicated markup.
 */
const ActiveDot = (): ReactNode => (
  <StatusDot
    label="Active in the last hour"
    testId="agent-active-dot"
    tone="active"
  />
);

// ---------------------------------------------------------------------------
// Name lead — navigates to the component detail page when href is provided
// ---------------------------------------------------------------------------

function renderNameLead(
  component: AgentComponent,
  getComponentHref?: (item: AgentComponent) => string
): ReactNode {
  // FEA-3775: long component names (e.g. `mcp__closedloop__create-document-
  // version`) used to overflow the lead cell and render underneath the Type
  // chip in the adjacent column. The name is a block-level `truncate` element
  // with `min-w-0`, wrapped in an interactive sd3 Tooltip carrying the full
  // value on hover/focus — the same treatment the sessions table uses for long
  // branch/PR labels (FEA-3644). `truncate` on the anchor/span (not just a
  // nested inline span) is what actually clamps it to the flex `min-w-0` track,
  // so the name ellipsizes before it can collide with the Type chip.
  //
  // Component names are code identifiers, so the cell renders them in the same
  // mono face as the tooltip (and as the sessions-table branch/PR labels) — one
  // typeface for the trigger and content, not two (`font-mono` from the shared
  // TRUNCATED_LABEL_CLASS). `font-medium` keeps the lead's link weight.
  const nameClassName = `block ${TRUNCATED_LABEL_CLASS} font-medium text-sm`;

  // Full name available on hover/focus via the design-system tooltip. The
  // truncating element is the trigger itself so the tooltip injects no extra
  // wrapper that would defeat min-w-0 truncation:
  //   • href supplied → `asChild` over the surface-agnostic `@repo/navigation`
  //     `Link` (a keyboard-focusable anchor), driving the active adapter on
  //     both surfaces. Why `Link` and not a raw `<a>`, and the per-surface href
  //     shape: see the `getComponentHref` prop doc below (FEA-4018).
  //   • no href       → the (non-asChild) Radix trigger renders its own native
  //     `<button>`, which is focusable/interactive by default (so no
  //     tabIndex-on-a-plain-span a11y smell), left-aligned to truncate like text.
  const nameTrigger = getComponentHref ? (
    <TooltipTrigger asChild>
      <Link
        className={`${nameClassName} hover:underline`}
        href={getComponentHref(component)}
      >
        {component.name}
      </Link>
    </TooltipTrigger>
  ) : (
    <TooltipTrigger className={`${nameClassName} text-left`} type="button">
      {component.name}
    </TooltipTrigger>
  );

  const name = (
    <TruncatedLabelTooltip fullValue={component.name} trigger={nameTrigger} />
  );

  // Trailing indicators — FEA-3620 unified both into the same pulsing-dot
  // vocabulary, so a single row can carry BOTH dots inline, differentiated only
  // by tone:
  //   • FEA-3176: a "New" dot (success tone) when discovered in the last 7 days.
  //   • FEA-3179: a "live" dot (primary tone) when invoked in the last hour —
  //     keyed off the real `lastInvokedAt`, never the sync-refreshed `lastSeenAt`.
  const isNew = isNewlyDiscovered(component.firstSeenAt);
  const isActive = isRecentlyActive(component.lastInvokedAt);
  // FEA-4267: the collapsed-family "N versions" count is NOT a trailing signal
  // here anymore — it lives in its own `versions` column (see VersionsCell), so
  // the busiest row (name + New dot + live dot) no longer stacks a third,
  // wider signal onto an already-ellipsized name. Only the two 6px dots trail
  // the name.
  if (!(isNew || isActive)) {
    return name;
  }
  // The dots are `shrink-0` (see NewDot/ActiveDot) so they keep their own space
  // and the truncating name yields width to them, never the reverse.
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {name}
      {isNew ? <NewDot /> : null}
      {isActive ? <ActiveDot /> : null}
    </span>
  );
}

/**
 * FEA-4267: the "N versions" count for a collapsed family row, rendered in its
 * own right-aligned column at value scale (`text-sm`, muted) so it matches the
 * other count cells (Invocations/Sessions) and reads as a value rather than the
 * `text-xs` label scale the table's field labels use. Null — an em-dash empty
 * value — unless the row is BOTH a multi-version family (`versionCount > 1`; the
 * service omits `versionCount` for single-version rows) AND a kind whose detail
 * page actually surfaces a version dropdown (`hasVersionHistoryAffordance`). A
 * count with no destination is worse than no count: an mcp/tool/hook/config
 * family lands on a detail page with no version affordance, so it must not
 * promise one here — the same predicate gates the detail-page Prompt panel, so
 * the two cannot drift.
 */
const VersionsCell = ({
  component,
  alignEnd,
}: {
  component: AgentComponent;
  /** ISS-4973: see {@link NumberCell}. Grid-only, flag-gated. */
  alignEnd?: boolean;
}): ReactNode => {
  if (!hasVersionCountSignal(component)) {
    // ISS-5333: see {@link NumberCell} — the dash tracks the column's alignment.
    return <GridEmptyValue alignEnd={alignEnd} />;
  }
  return (
    <span
      className={cn(
        "text-muted-foreground text-sm tabular-nums",
        alignEnd && "ml-auto"
      )}
      data-testid="agent-version-count"
    >
      {NUMBER_FORMAT.format(component.versionCount)}
    </span>
  );
};

/**
 * FEA-4267: whether this row populates the Versions column — a collapsed
 * multi-version family (`versionCount > 1`; the service omits `versionCount`
 * for single-version rows) whose kind actually surfaces a version dropdown on
 * its detail page. The single predicate behind both the cell (what it renders)
 * and the column gate (whether the whole column shows), so an all-empty
 * Versions column of em-dashes never appears when no family qualifies.
 */
function hasVersionCountSignal(
  component: AgentComponent
): component is AgentComponent & { versionCount: number } {
  const { versionCount, kind } = component;
  return (
    versionCount !== undefined &&
    versionCount > 1 &&
    hasVersionHistoryAffordance(kind)
  );
}

// ---------------------------------------------------------------------------
// AgentsTable
// ---------------------------------------------------------------------------

export type AgentsTableGroup = GridTableGroup<AgentComponent>;

export type AgentsTableProps = {
  items: AgentComponent[];
  /**
   * Pre-computed groups for the grouped layout. When provided, `items` is
   * ignored and the table renders one collapsible section per group.
   */
  groups?: AgentsTableGroup[];
  /** Sort column id currently active. */
  sortBy: string;
  /** Sort direction currently active. */
  sortDir: AgentComponentSortDir;
  /** Fired when the user clicks a sortable column header. */
  onSort: (col: string, dir: AgentComponentSortDir) => void;
  /**
   * Set of column ids that should be visible. When provided, columns not in
   * this set are omitted (the column and its grid track are dropped together).
   * When absent, all columns are visible.
   */
  visibleColumns?: Set<string>;
  /**
   * FEA-4021: drag-to-reorder / keyboard-reorder for the DATA columns. Pass the
   * persisted order (data-column ids) + a change handler; the trailing `actions`
   * column stays pinned at the end and never reorders. Absent → static headers.
   */
  columnOrder?: readonly string[];
  onColumnOrderChange?: (nextOrder: string[]) => void;
  /**
   * When provided, clicking a row's Name lead navigates to the returned href.
   * FEA-4018: the lead renders the surface-agnostic `@repo/navigation` `Link`
   * so the click reaches the active navigation adapter on both web (Next
   * router) and the desktop renderer (hash-store adapter) — a raw `<a>` was a
   * dead click on desktop. Each surface supplies its own destination (web:
   * `/{org}/agents/{slug}`, org-prefixed by the caller — the Next adapter's
   * Link adds no org segment; desktop: the route-table path `/agents/{slug}`,
   * which the desktop adapter renders hash-prefixed so modifier/middle-click
   * stays resolvable in-app). Mirrors `AgentRowActionsMenu`.
   */
  getComponentHref?: (item: AgentComponent) => string;
  /**
   * The persisted metric-display mode (`useAgentComponentsViewState`).
   *
   * ISS-4866: the Metric column no longer READS it. ISS-4667 left LOC/$ as the
   * metric's one unit and one orientation, so both modes rendered the identical
   * value and the per-mode switch here was a transform that no longer
   * transformed. The prop stays on the contract because the saved-view state
   * (and its legacy-value migration) still carries the mode; re-differentiating
   * it is a one-line change in `MetricCell`, alongside restoring the picker
   * ISS-4866 retires.
   */
  metricMode: AgentMetricMode;
  /**
   * FEA-3866: layout mode forwarded to `GridTable`. Defaults to `auto` — a card
   * list below the `md` container width, the grid at `md+`. Callers rarely set
   * this; it exists to pin one layout (and to let tests exercise a single mode).
   */
  mode?: GridTableMode;
  /**
   * FEA-3872: force the row-actions affordance always visible instead of
   * hover-revealed (the RN-parity seam — RN has no hover). Undefined keeps the
   * pointer-aware web/desktop default. See {@link AdaptiveProps}.
   */
  alwaysShowActions?: boolean;
};

export function AgentsTable({
  items,
  groups,
  sortBy,
  sortDir,
  onSort,
  visibleColumns,
  columnOrder,
  onColumnOrderChange,
  getComponentHref,
  mode,
  alwaysShowActions,
}: AgentsTableProps): ReactNode {
  // Filter data columns by visibility, append the always-visible actions column,
  // and drop any low-variance column (FEA-3968). Memoized on the inputs so the
  // O(columns × rows) collapse scan does not re-run on unrelated re-renders
  // (e.g. hover/pagination) of a large grouped inventory.
  const { columns, gridTemplateColumns, orderedDataColumnIds } = useMemo(() => {
    // Both header deltas merge over the SAME base list, so the id, label, width
    // and sortability stay single-sourced from `COLUMN_SPECS` and the two deltas
    // compose instead of one overwriting the other's spec.
    const baseSpecs = COLUMN_SPECS.map((spec) => {
      if (spec.id === "metric") {
        return { ...spec, ...POLISHED_METRIC_HEADER };
      }
      if (ALIGNED_COUNT_COLUMN_IDS.has(spec.id)) {
        return { ...spec, ...ALIGNED_COUNT_HEADER };
      }
      return spec;
    });
    const requestedSpecs = visibleColumns
      ? baseSpecs.filter((spec) => visibleColumns.has(spec.id))
      : baseSpecs;
    // FEA-3968: collapse drops a categorical column constant across every visible
    // row (header, cells, AND grid track in lockstep). In grouped mode `items` is
    // ignored by the grid, so collapse scans the flattened group rows.
    const collapseItems = groups
      ? groups.flatMap((group) => group.items)
      : items;
    // FEA-4267: the Versions column is opt-in per page — it appears only when at
    // least one visible row is a collapsed multi-version family whose kind has a
    // version dropdown to link to. Most inventories have none, and the table
    // runs the collapse helper in constant-only mode (empty columns are NOT
    // auto-dropped), so gate the column here rather than let an all-em-dash
    // column render down a page with no families.
    const visibleSpecs =
      requestedSpecs.some((spec) => spec.id === "versions") &&
      !collapseItems.some(hasVersionCountSignal)
        ? requestedSpecs.filter((spec) => spec.id !== "versions")
        : requestedSpecs;
    // Columns kept regardless of low variance: the active sort column (dropping
    // its header would strand the user with no way to reverse a sort that still
    // controls which paginated bucket shows — wongk), Metric (an all-zero
    // "LOC / $" is the answer the user picked from the metric-mode control, not
    // an absence), and the canonical Type/Harness/Source columns (FEA-4248). With
    // all four exempt, nothing collapses today; see NEVER_COLLAPSE_COLUMN_IDS.
    const keepColumnIds = new Set([
      sortBy,
      "metric",
      ...NEVER_COLLAPSE_COLUMN_IDS,
    ]);
    const collapsedSpecs = collapseConstantColumns(
      visibleSpecs,
      collapseItems,
      agentCollapseKey,
      keepColumnIds,
      // Constant-only: a single filtered component that merely lacks a metric
      // keeps its columns; only a value repeated down 2+ rows collapses.
      { collapseEmptyColumns: false }
    );
    // FEA-4021: reorder the surviving visible DATA specs by the persisted
    // `columnOrder` (ids not in the order keep their natural position at the end
    // via the shared helper), so a column AND its grid track move together. The
    // trailing `actions` spec is appended AFTER and never reorders.
    const dataSpecs = orderColumns(collapsedSpecs, columnOrder);
    const specs = [...dataSpecs, ACTIONS_SPEC];
    return {
      columns: specs.map(({ width: _w, ...col }) => col) as GridTableColumn[],
      gridTemplateColumns: [
        LEAD_WIDTH,
        ...specs.map((spec) => spec.width),
      ].join(" "),
      orderedDataColumnIds: dataSpecs.map((spec) => spec.id),
    };
  }, [visibleColumns, columnOrder, groups, items, sortBy]);

  // Adapt AgentComponentSortDir → GridTable's SortDirection string union.
  const sortDirNormalized: SortDirection = sortDir === "desc" ? "desc" : "asc";

  const handleSort = (col: string, dir: SortDirection): void => {
    onSort(col, dir as AgentComponentSortDir);
  };

  // FEA-4021: the header can only reorder the columns it renders — the visible,
  // non-collapsed subset. Merge the reordered visible ids back into the COMPLETE
  // data order (every `COLUMN_SPECS` id) so a hidden/collapsed column keeps its
  // slot. Wrapped only when the caller wired a change handler.
  const handleColumnOrderChange = onColumnOrderChange
    ? (visibleOrder: string[]) =>
        onColumnOrderChange(mergeColumnOrder(ALL_DATA_COLUMN_IDS, visibleOrder))
    : undefined;

  // One cell renderer feeds both the grid rows and the card body, so the card
  // and the row can never drift — every column renders the same chip/badge.
  // ISS-4866 adds exactly ONE deliberate difference, `alignEnd`: the grid's
  // metric column is right-aligned (that is what makes its one fixed precision
  // line the decimals up), while the card renders the same value inline beside
  // the Type chip where a stretch to the far edge would orphan it. Same node,
  // same formatter, same tone — only the alignment differs.
  //
  // ISS-4973 adds the second alignment seam, `alignCountsEnd`, for the three
  // count columns. Both booleans mean the same thing and only that thing: "this
  // is the GRID, where a right-aligned column is possible at all". The card
  // renderer below passes NEITHER, which is what preserves its inline key/value
  // layout — that seam is the contract, not a side effect of the gates ISS-5366
  // retired. Do not "simplify" it by pushing the alignment down into the cells.
  const renderCellForGrid = (columnId: string, item: AgentComponent) =>
    renderCell(columnId, item, {
      getComponentHref,
      alwaysShowActions,
      alignEnd: true,
      alignCountsEnd: true,
    });
  const renderCellForCard = (columnId: string, item: AgentComponent) =>
    renderCell(columnId, item, {
      getComponentHref,
      alwaysShowActions,
    });

  return (
    <GridTable<AgentComponent>
      cardRender={(item, cardColumns) => (
        <AgentCard
          alwaysShowActions={alwaysShowActions}
          columns={cardColumns}
          getComponentHref={getComponentHref}
          item={item}
          renderCell={renderCellForCard}
        />
      )}
      columnOrder={orderedDataColumnIds}
      columns={columns}
      getRowId={(item) => item.id}
      gridTemplateColumns={gridTemplateColumns}
      groups={groups}
      items={items}
      leadingLabel="Component"
      leadingSortKey="name"
      mode={mode}
      onColumnOrderChange={handleColumnOrderChange}
      onSort={handleSort}
      renderCell={renderCellForGrid}
      renderLead={(item) => renderNameLead(item, getComponentHref)}
      sortBy={sortBy}
      sortDir={sortDirNormalized}
    />
  );
}

// The Type badge and the metric lead the card header (a chip + value under the
// name), and the row-actions menu sits in the header too, so none is repeated in
// the key/value body. Every other visible column stays in the body.
const AGENT_CARD_HEADER_COLUMN_IDS = new Set([
  "type",
  "metric",
  ROW_ACTIONS_COLUMN_ID,
]);

/**
 * Narrow-surface card for one agent-component row (FEA-3866). Header: component
 * name lead (with its New/Active dots) + Type badge + the efficiency metric,
 * with the always-visible row-actions menu. Body: the remaining visible columns
 * (Authors, Source, Harness, Invocations, Sessions) rendered as a
 * key/value list via the table's own `renderCell` so the card and the grid row
 * never drift. Built on the shared `GridTableCard`.
 *
 * Exported as the feature's `<Feature>Card` companion (FEA-3872) so an RN
 * adapter can render one agent component as a card without the grid path.
 */
export function AgentCard({
  item,
  columns,
  renderCell: renderCellForItem,
  getComponentHref,
  alwaysShowActions,
}: {
  item: AgentComponent;
  columns: readonly GridTableColumn[];
  renderCell: (columnId: string, item: AgentComponent) => ReactNode;
  getComponentHref?: (item: AgentComponent) => string;
  alwaysShowActions?: boolean;
}): ReactNode {
  // Route the card body through the shared builder so the label-less-column rule
  // (a blank `label` reads by its `ariaLabel` on the card, where there is no
  // header row to fall back on) lives in ONE place — the same helper the
  // Sessions/Branches cards use — instead of this file re-deriving `label:
  // column.label` and diverging (ISS-4672).
  const fields = buildGridTableCardFields(
    columns,
    AGENT_CARD_HEADER_COLUMN_IDS,
    renderCellForItem,
    item
  );
  // FEA-3968: honor the surviving grid column set on the card too — a column the
  // grid dropped must not resurface in the card header, or it would vanish on the
  // desktop/mobile grid yet repeat on every narrow-screen card. `columns` is the
  // surviving set the grid passes down; the card mirrors it. FEA-4248 exempts
  // Type (like Harness/Source) from the low-variance collapse, so it stays in
  // that set today — the guard tracks whatever the grid passes rather than
  // assuming Type is always present.
  const survivingIds = new Set(columns.map((column) => column.id));
  const showType = survivingIds.has("type");
  // ISS-5475 (review cid 3737914557): the metric carries its UNIT on the card.
  // On the grid the column header names it, but the card has no header row, and
  // with the per-row tone deleted a bare "2.50" sat beside a "Subagent" badge,
  // reading as more chip metadata rather than a measurement. The label is the
  // same `LOC_PER_DOLLAR_LABEL` the column header uses, so the two surfaces
  // cannot name the unit differently. The value keeps its header placement
  // (FEA-3866 promotes it as a headline attribute) rather than being demoted
  // into the key/value body, which was the other option the reviewer offered.
  //
  // The label is CONDITIONAL, because an unavailable metric renders the `—`
  // sentinel: pinning a label in front of it unconditionally would make every
  // unpriced row's card header read "LOC / $ —", where the card BODY drops its
  // empty key/value rows outright. The whole labelled group goes instead, so the
  // header and the body agree on what an unavailable value means.
  //
  // The condition reads the DATUM, not `isEmptyCellValue` on the rendered node.
  // `renderCell` returns `<MetricCell …>`, and the `GridEmptyValue` sentinel is
  // produced INSIDE that component at render time — so `isEmptyCellValue`, which
  // matches on element TYPE, sees `MetricCell` and reports non-empty for every
  // row including the null ones. (The `MetricCell` null branch's own note about
  // the card "dropping empty rows on that test" describes the generic body path;
  // it never applies to this column, which `AGENT_CARD_HEADER_COLUMN_IDS` keeps
  // out of the body entirely.) `locPerDollar` is the single input to that
  // branch, so testing it here matches the sentinel exactly.
  const showMetric = item.locPerDollar !== null;
  return (
    <GridTableCard
      fields={fields}
      header={
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            {renderNameLead(item, getComponentHref)}
            {/* Type + metric read as the card's headline attributes under the
                name — rendered through the table's own cell renderer, so the
                chip and value are identical to the grid row. Type is omitted when
                it collapsed out of the grid so the card never repeats a value the
                grid dropped. */}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {showType ? renderCellForItem("type", item) : null}
              {showMetric ? (
                <span className="flex min-w-0 items-center gap-1">
                  <span className="text-muted-foreground text-xs">
                    {LOC_PER_DOLLAR_LABEL}
                  </span>
                  {renderCellForItem("metric", item)}
                </span>
              ) : null}
            </div>
          </div>
          {/* Actions live inline in the card header, always visible (no hover on
              touch): the grid path is the one that hover-reveals. The card is
              itself the narrow surface, so actions are always painted unless the
              host explicitly opts out of the always-show seam. */}
          <span className="shrink-0">
            <ActionsCell
              alignEnd={false}
              alwaysShowActions={alwaysShowActions ?? true}
              component={item}
              getComponentHref={getComponentHref}
            />
          </span>
        </div>
      }
    />
  );
}

type RenderCellOptions = {
  /** Threaded to the actions-column menu so "Open detail" can link to the
   * per-component detail route (same href factory the Name lead uses). */
  getComponentHref?: (item: AgentComponent) => string;
  alwaysShowActions?: boolean;
  /**
   * ISS-4866: right-align the value cells that belong to a right-aligned column
   * header. Set by the GRID renderer only — the narrow card lays the same values
   * out inline, where stretching one to the far edge would orphan it from the
   * chip it sits beside.
   */
  alignEnd?: boolean;
  /**
   * ISS-4973: right-align the three COUNT columns (Invocations / Sessions /
   * Versions). Separate from {@link RenderCellOptions.alignEnd} because it is
   * gated by its own flag — see `renderCellForGrid`. Set by the GRID renderer
   * only; the narrow card omits it for the same reason it omits `alignEnd`.
   */
  alignCountsEnd?: boolean;
};

function renderCell(
  columnId: string,
  component: AgentComponent,
  {
    getComponentHref,
    alwaysShowActions,
    alignEnd,
    alignCountsEnd,
  }: RenderCellOptions
): ReactNode {
  switch (columnId) {
    case "type":
      return <KindLabel kind={component.kind} />;
    case "metric":
      return <MetricCell alignEnd={alignEnd} component={component} />;
    // FEA-4098 (Slice 3): the Authors column (internal `collaborators` key)
    // renders the authors people-set (discoverer + editors) from the version
    // lineage, replacing Owner.
    case "collaborators":
      return <CollaboratorStack users={component.collaborators} />;
    case "source":
      return <SourceLabel component={component} />;
    case "harness":
      return <HarnessBadge harness={component.harness} />;
    case "invocations":
      return (
        <NumberCell alignEnd={alignCountsEnd} value={component.invocations} />
      );
    case "sessions":
      return (
        <NumberCell alignEnd={alignCountsEnd} value={component.sessions} />
      );
    // FEA-4267: collapsed-family version count, gated to kinds with a real
    // version dropdown on their detail page (see VersionsCell).
    case "versions":
      return <VersionsCell alignEnd={alignCountsEnd} component={component} />;
    case ROW_ACTIONS_COLUMN_ID:
      return (
        <ActionsCell
          alwaysShowActions={alwaysShowActions}
          component={component}
          getComponentHref={getComponentHref}
        />
      );
    default:
      return null;
  }
}

/**
 * FEA-3968 collapse extractor: a stable per-cell key per categorical column.
 * Dormant today — FEA-4248 exempts Type/Harness/Source via `keepColumnIds`, so
 * no shipped column collapses — but retained so a future non-canonical
 * categorical column can opt in without re-wiring the key. Columns with no case
 * here (Metric, Invocations, Sessions, Authors) are kept by the helper
 * under the constant-only mode this table uses.
 */
function agentCollapseKey(
  columnId: string,
  component: AgentComponent
): CollapseCellKey {
  switch (columnId) {
    case "type":
      return component.kind;
    case "harness":
      return component.harness;
    case "source":
      return `${component.sourceType}:${component.source}`;
    default:
      // No extractor entry ⇒ the shared helper keeps the column unconditionally.
      return COLLAPSE_EMPTY;
  }
}

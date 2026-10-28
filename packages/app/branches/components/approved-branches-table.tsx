"use client";

import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { ComponentProps, ReactNode } from "react";
import { withoutBranchPriorityColumn } from "../lib/branch-column-view-model";
import type { BranchRow } from "../lib/branch-row";
import {
  APPROVED_BRANCH_COLUMN_SPECS,
  APPROVED_BRANCH_LEAD_WIDTH,
  type ApprovedBranchLeadRenderInput,
  approvedBranchRepositoryLabels,
  renderApprovedBranchCell,
  renderApprovedBranchLead,
} from "./approved-branches-grid-adapter";

/** Fixed, horizontally scrollable PRD-601 table with visibility-only columns. */
export function ApprovedBranchesTable({
  items,
  allRows = items,
  visibleColumns,
  getBranchHref,
  renderBranchLink,
  getSessionsHref,
  sortBy,
  sortDir,
  onSort,
  tagsReadOnly = false,
  includePriorityColumn = false,
}: {
  items: BranchRow[];
  allRows?: BranchRow[];
  visibleColumns?: Set<string>;
  getBranchHref?: (item: BranchRow) => string;
  renderBranchLink?: (input: ApprovedBranchLeadRenderInput) => ReactNode;
  getSessionsHref?: (item: BranchRow) => string;
  sortBy?: string | null;
  sortDir?: SortDirection;
  onSort?: (column: string, direction: SortDirection) => void;
  tagsReadOnly?: boolean;
  /** ISS-10332: the host's source serves `priority`; absent, no Priority column. */
  includePriorityColumn?: boolean;
}) {
  // ISS-6959 — pin the Name column so a horizontally scrolled row keeps the
  // identifier its values belong to. Read HERE rather than taken as a prop, so
  // one flag has one read site (`check:source-gates` → `no-threaded-feature-flag`).
  const pinNameColumn = useFeatureFlagEnabledOptional(
    BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY
  );
  const offeredSpecs = includePriorityColumn
    ? APPROVED_BRANCH_COLUMN_SPECS
    : withoutBranchPriorityColumn(APPROVED_BRANCH_COLUMN_SPECS);
  const specs = visibleColumns
    ? offeredSpecs.filter((spec) => visibleColumns.has(spec.id))
    : offeredSpecs;
  const labels = approvedBranchRepositoryLabels(allRows);
  const gridProps: ComponentProps<typeof GridTable<BranchRow>> = {
    columns: specs.map(
      ({ width: _width, ...column }) => column satisfies GridTableColumn
    ),
    getRowId: (item) => item.id,
    gridTemplateColumns: [
      APPROVED_BRANCH_LEAD_WIDTH,
      ...specs.map((spec) => spec.width),
    ].join(" "),
    items,
    leadingLabel: "Name",
    leadingSortKey: "name",
    mode: "expanded",
    onSort,
    renderCell: (columnId, item) =>
      renderApprovedBranchCell(
        columnId,
        item,
        labels,
        getSessionsHref,
        tagsReadOnly
      ),
    renderLead: (item) =>
      renderApprovedBranchLead(item, getBranchHref, renderBranchLink),
    sortBy,
    sortDir,
  };
  // The flag picks between two whole shapes rather than travelling into
  // `GridTable` as a prop, which is the `no-threaded-feature-flag` contract: one
  // read site, and a boolean that never crosses a module boundary. The two
  // branches share `gridProps`, so the pin is the only thing that can differ.
  return pinNameColumn ? (
    <GridTable<BranchRow> {...gridProps} pinLeadColumn />
  ) : (
    <GridTable<BranchRow> {...gridProps} />
  );
}

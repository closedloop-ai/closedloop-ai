import type { GridTableV2Column } from "@repo/design-system/components/ui/grid-table-v2";
import { resolveColumnLayout } from "@repo/design-system/lib/column-layout";
import {
  applyColumnWidths,
  mergeColumnOrder,
  orderColumns,
} from "@repo/design-system/lib/column-order";
import {
  APPROVED_BRANCH_LEAD_WIDTH,
  type ApprovedBranchColumnSpec,
  approvedBranchColumnPixelWidth,
  approvedBranchColumnRegistry,
} from "./approved-branches-grid-adapter";

/**
 * The four facts a `GridTableV2` mount needs about its data columns, plus the
 * round trip that turns a header-emitted visible order back into a persistable
 * one.
 *
 * Named as one shape because ISS-9316's gate picks between two WHOLE
 * derivations of it: the hand-built one this surface has always had, and
 * `resolveColumnLayout` over one declaration set. Everything downstream reads
 * the shape, never the branch.
 */
export type BranchColumnLayout = {
  columnOrder: string[];
  columns: GridTableV2Column[];
  columnWidths: Record<string, number>;
  gridTemplateColumns: string;
  toPersistedColumnOrder: (visibleOrder: readonly string[]) => string[];
};

/**
 * `columnSpecs` is the set the SURFACE picked, not the module default. Both
 * registry arms preserve the canonical "Linked sessions" column label.
 */
export type BranchColumnLayoutInput = {
  columnSpecs: readonly ApprovedBranchColumnSpec[];
  columnWidths?: Readonly<Record<string, number>>;
  resolvedColumnOrder: readonly string[];
  visibleColumns: Set<string>;
};

/** The legacy path: four derivations beside each other. Kept as the rollback. */
export function handBuiltBranchColumnLayout({
  columnSpecs,
  columnWidths,
  resolvedColumnOrder,
  visibleColumns,
}: BranchColumnLayoutInput): BranchColumnLayout {
  const orderedSpecs = orderColumns(
    columnSpecs.filter((spec) => visibleColumns.has(spec.id)),
    resolvedColumnOrder
  );
  const naturalColumnWidths = Object.fromEntries(
    orderedSpecs.map((spec) => [
      spec.id,
      approvedBranchColumnPixelWidth(spec.width),
    ])
  );
  const resizedColumnWidths = applyColumnWidths(
    naturalColumnWidths,
    columnWidths
  );
  return {
    columnOrder: orderedSpecs.map((spec) => spec.id),
    columns: orderedSpecs.map(
      ({ width: _width, ...column }) => column satisfies GridTableV2Column
    ),
    columnWidths: resizedColumnWidths,
    gridTemplateColumns: [
      APPROVED_BRANCH_LEAD_WIDTH,
      ...orderedSpecs.map(
        (spec) =>
          `${resizedColumnWidths[spec.id] ?? approvedBranchColumnPixelWidth(spec.width)}px`
      ),
    ].join(" "),
    toPersistedColumnOrder: (visibleOrder) =>
      mergeColumnOrder(resolvedColumnOrder, visibleOrder),
  };
}

/**
 * The adopted path (ISS-9316): one declaration set in, one layout out, with the
 * lead identity track handed in as the caller-owned bracket the registry
 * deliberately does not declare.
 */
export function registryBranchColumnLayout({
  columnSpecs,
  columnWidths,
  resolvedColumnOrder,
  visibleColumns,
}: BranchColumnLayoutInput): BranchColumnLayout {
  // Resolved here and nowhere above: the accessor builds the registry on first
  // use, so the closed arm of the gate never constructs it.
  const registry = approvedBranchColumnRegistry(columnSpecs);
  return resolveColumnLayout(
    registry,
    {
      columnOrder: resolvedColumnOrder,
      columnWidths,
      // An explicit list, never absent: this surface always states its visible
      // set, so `defaultHidden` is not the fallback the grid should reach for.
      hiddenColumnIds: registry.definitions
        .filter((definition) => !visibleColumns.has(definition.id))
        .map((definition) => definition.id),
    },
    { leadingTracks: [APPROVED_BRANCH_LEAD_WIDTH] }
  );
}

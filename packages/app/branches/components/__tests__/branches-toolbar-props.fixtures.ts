import { DEFAULT_BRANCH_FILTERS } from "../../lib/branch-row";
import type { BranchesToolbarProps } from "../branches-toolbar-model";

/**
 * The arguments a Branches v2 mount needs to render its own toolbar.
 *
 * ISS-9225 made `BranchesListSurfaceV2` compose `BranchesListToolbarV2` instead
 * of taking an opaque `ReactNode`, so every suite that mounts the surface now
 * owes it a real `BranchesToolbarProps` — and three copies of the same literal
 * is how those suites come to disagree about what a branch toolbar is handed.
 *
 * `approved: true` is what BOTH production hosts pass (the web Branches page and
 * the desktop Branches view), so a mount built from this fixture resolves its
 * facets down the same branch production takes rather than the legacy one.
 */
export function branchesToolbarPropsFixture(
  overrides: Pick<BranchesToolbarProps, "rows" | "visibleColumns"> &
    Partial<BranchesToolbarProps>
): BranchesToolbarProps {
  return {
    approved: true,
    dateRange: "30d",
    filters: DEFAULT_BRANCH_FILTERS,
    onDateRangeChange: () => undefined,
    onFiltersChange: () => undefined,
    onToggleColumn: () => undefined,
    ...overrides,
  };
}

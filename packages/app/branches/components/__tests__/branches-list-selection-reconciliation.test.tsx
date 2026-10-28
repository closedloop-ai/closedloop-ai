import { TableBulkActionUndo } from "@repo/design-system/components/ui/table-bulk-actions";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { selectionSentence } from "../../../shared/components/generic-artifact-surface/bulk-action-bar";
import { stubContainerWidthPx } from "../../../test/mocks/container-width";
import type { BranchRow } from "../../lib/branch-row";
import { BRANCH_SAMPLE_ROWS } from "../../lib/branch-sample-data";
import { BRANCHES_NOUN } from "../../lib/branches-noun";
import { BranchesListSurfaceV2 } from "../branches-list-surface-v2";
import { branchesListSurfaceV2SummaryPropsFixture } from "./branches-list-surface-v2-props.fixtures";
import { branchesToolbarPropsFixture } from "./branches-toolbar-props.fixtures";

/**
 * PRD-718 AC-1, Branches host: selection follows the rows the reader can see.
 * The body mounts the grid only on `resolveBranchesListState`'s Rows rung, so
 * when it renders an empty state instead (a page that came back empty while
 * the server total is still positive), the host must reconcile, because no
 * mounted grid is there to report its rows.
 */

const ROWS: BranchRow[] = BRANCH_SAMPLE_ROWS.slice(0, 2).map((row, index) => ({
  ...row,
  id: `branch-${index}`,
}));
const VISIBLE_COLUMNS = new Set(["owner", "status"]);
const BULK_ACTIONS = [
  {
    icon: null,
    id: "noop",
    kind: "command" as const,
    label: "Do nothing",
    onSelect: () => undefined,
    undo: TableBulkActionUndo.NotImplemented,
  },
];
let restoreWidth: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restoreWidth?.();
  restoreWidth = undefined;
});

describe("Branches selection while the grid is unmounted", () => {
  it("drops ids a filtered-empty page hides even though the total stays positive", () => {
    restoreWidth = stubContainerWidthPx(1440);
    const { container, rerender } = render(
      <Surface items={ROWS} total={ROWS.length} />
    );
    fireEvent.click(rowOf(container, "branch-0"));
    fireEvent.click(rowOf(container, "branch-1"), { ctrlKey: true });
    expect(
      screen.getByRole("toolbar", { name: selectionSentence(2, BRANCHES_NOUN) })
    ).toBeInTheDocument();

    rerender(<Surface hasActiveFilters items={[]} total={7} />);
    expect(container.querySelector("[data-grid-row-id]")).toBeNull();

    rerender(<Surface items={ROWS} total={ROWS.length} />);
    expect(rowOf(container, "branch-0").getAttribute("aria-selected")).toBe(
      "false"
    );
    expect(rowOf(container, "branch-1").getAttribute("aria-selected")).toBe(
      "false"
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});

function Surface({
  hasActiveFilters = false,
  items,
  total,
}: {
  hasActiveFilters?: boolean;
  items: BranchRow[];
  total: number;
}) {
  return (
    <TooltipProvider>
      <BranchesListSurfaceV2
        allRows={items}
        bulkActions={BULK_ACTIONS}
        {...branchesListSurfaceV2SummaryPropsFixture()}
        hasActiveFilters={hasActiveFilters}
        hasWindow={false}
        isError={false}
        isPending={false}
        isPlaceholderData={false}
        items={items}
        onPageChange={() => undefined}
        onPageSizeChange={() => undefined}
        onRetry={() => undefined}
        onShowAllTime={() => undefined}
        onSort={() => undefined}
        page={0}
        pageSize={25}
        sortBy="lastActivity"
        sortDir="desc"
        toolbar={branchesToolbarPropsFixture({
          rows: items,
          visibleColumns: VISIBLE_COLUMNS,
        })}
        total={total}
        totalPages={1}
        visibleColumns={VISIBLE_COLUMNS}
      />
    </TooltipProvider>
  );
}

function rowOf(container: HTMLElement, id: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(
    `[data-grid-row-id="${id}"]`
  );
  if (!row) {
    throw new Error(`Missing row ${id}`);
  }
  return row;
}

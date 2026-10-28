import { GRID_EMPTY_VALUE_GLYPH } from "@repo/design-system/components/ui/grid-table-card";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL } from "../../lib/branch-outcome-copy";
import type { BranchRow } from "../../lib/branch-row";
import { BRANCH_SAMPLE_ROWS } from "../../lib/branch-sample-data";
import { BranchesTable } from "../branches-table";

/**
 * ISS-8422 through the component users actually get.
 *
 * `BranchPRBadge`'s own suite proves the badge; it cannot prove the badge is
 * REACHED. `approved` is load-bearing and not a default — `BranchesTable`
 * returns early into `ApprovedBranchesTable` when it is set, and that is the
 * variant both the web page and the desktop view pass — so a cell-level green
 * over the legacy GridTable path would be grading a table no user sees.
 */
const PR_COLUMN = "pr";
const PR_NUMBER_RE = /#1274/;

function renderPrColumn(row: BranchRow) {
  return render(
    <AppCoreStoryProviders>
      <BranchesTable
        allRows={[row]}
        approved
        columnOrder={[]}
        columnWidths={{}}
        items={[row]}
        onColumnOrderChange={() => undefined}
        onColumnWidthChange={() => undefined}
        onSort={() => undefined}
        sortBy="lastActivity"
        sortDir="desc"
        visibleColumns={new Set([PR_COLUMN])}
      />
    </AppCoreStoryProviders>
  );
}

function branchRow(overrides: Partial<BranchRow>): BranchRow {
  const base = BRANCH_SAMPLE_ROWS[0];
  if (!base) {
    throw new Error("BRANCH_SAMPLE_ROWS is empty");
  }
  return { ...base, ...overrides };
}

describe("approved Branches table, pull-request cell", () => {
  it("renders an unobserved PR as a numbered chip that states it is unconfirmed", () => {
    renderPrColumn(
      branchRow({
        id: "unobserved",
        prNumber: 1274,
        prState: null,
        prTitle: null,
        prUrl: "https://github.com/acme/web/pull/1274",
      })
    );

    expect(screen.getByText(PR_NUMBER_RE)).toBeInTheDocument();
    expect(
      screen.getByText(BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL)
    ).toBeInTheDocument();
    // Not the no-PR affordance: the row has a pull request and links to it.
    expect(screen.queryByText(GRID_EMPTY_VALUE_GLYPH)).not.toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://github.com/acme/web/pull/1274"
    );
  });

  it("leaves an observed PR unlabelled, so the word marks one state only", () => {
    renderPrColumn(
      branchRow({
        id: "observed",
        prNumber: 1274,
        prState: "OPEN",
        prUrl: "https://github.com/acme/web/pull/1274",
      })
    );

    expect(screen.getByText(PR_NUMBER_RE)).toBeInTheDocument();
    expect(
      screen.queryByText(BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL)
    ).not.toBeInTheDocument();
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type BranchRow,
  BranchRowStatus,
  RENDER_MISSING,
  RENDER_UNATTRIBUTED,
} from "../../lib/branch-row";
import { BranchesTable } from "../branches-table";

// FEA-3865: the GridTable card fallback on the Branches table. `compact` forces
// the card list so the selection is deterministic in jsdom; the header must keep
// the status chip and the row-actions menu (with the host's handlers bound), and
// the body must carry every data column, including an optional `extra` column.

const ROW: BranchRow = {
  id: "owner%2Fweb::feature",
  branchName: "feature/full",
  baseBranch: "main",
  repo: "owner/web",
  owner: "Alex Rivera",
  status: BranchRowStatus.Open,
  prNumber: 42,
  prTitle: "Add feature",
  prUrl: "https://gh/owner/web/pull/42",
  prState: "OPEN",
  checksPassed: 12,
  checksTotal: 12,
  checksStatus: "PASSING",
  behind: 1,
  ahead: 2,
  additions: 10,
  deletions: 5,
  sessionCount: 3,
  commentCount: null,
  lastActivityLabel: "2h ago",
};

describe("BranchesTable card fallback (FEA-3865)", () => {
  it("renders the card header with the branch name and the wired row-actions menu", () => {
    render(<BranchesTable items={[ROW]} mode="compact" />);

    // The card renders (not the grid): the branch name is in the header and the
    // body is a `<dt>`/`<dd>` definition list.
    expect(screen.getByText("feature/full")).toBeInTheDocument();
    expect(screen.getByText("Repository").tagName).toBe("DT");

    // The row-actions menu renders inside the card header via the table's own
    // (handler-bound) cell renderer, so the trigger is present. Passing the
    // renderer, not an empty actions object, is what keeps the handlers wired.
    expect(
      screen.getByRole("button", { name: "Branch actions" })
    ).toBeInTheDocument();
  });

  it("renders the optional extra column in the card body", () => {
    render(
      <BranchesTable
        extraColumnLabel="Version"
        items={[ROW]}
        mode="compact"
        renderExtraColumn={() => <span>v3</span>}
      />
    );

    const extraLabel = screen.getByText("Version");
    expect(extraLabel.tagName).toBe("DT");
    expect(screen.getByText("v3")).toBeInTheDocument();
  });

  it("drops columns that render empty from the card body instead of listing dash lines", () => {
    // A branch missing repo, owner, sessions, PR, and checks — every one of
    // those cells renders the shared em-dash empty-value. In the card body those
    // must NOT show as "Repository —", "Owner —" lines (a run of dashes reads as
    // a broken card); only the columns with real values remain.
    const sparseRow: BranchRow = {
      ...ROW,
      id: "owner%2Fweb::sparse",
      repo: RENDER_MISSING,
      owner: RENDER_UNATTRIBUTED,
      sessionCount: 0,
      prNumber: null,
      prTitle: null,
      prUrl: null,
      prState: null,
      checksPassed: null,
      checksTotal: null,
      checksStatus: null,
    };
    render(<BranchesTable items={[sparseRow]} mode="compact" />);

    // Last active still carries a value, so its label remains…
    expect(screen.getByText("Last active")).toBeInTheDocument();
    // …but the empty-rendering columns are omitted, no dash line.
    expect(screen.queryByText("Repository")).not.toBeInTheDocument();
    expect(screen.queryByText("Owner")).not.toBeInTheDocument();
    expect(screen.queryByText("Linked Sessions")).not.toBeInTheDocument();
    expect(screen.queryByText("Pull request")).not.toBeInTheDocument();
    expect(screen.queryByText("Checks")).not.toBeInTheDocument();
  });
});

import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type BranchRow, BranchRowStatus } from "../../lib/branch-row";
import { BranchesTable } from "../branches-table";

/**
 * ISS-6959 — the Branches list keeps its Name column on screen while the table
 * scrolls horizontally.
 *
 * WHAT LAYER THIS COVERS, precisely: it drives the real production path —
 * `BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY` → `BranchesTable`'s flag read →
 * `ApprovedBranchesTable`'s `pinNameColumn` → `GridTable`'s `pinLeadColumn` →
 * the class list the lead cells render with — and asserts the outcome in the
 * DOM. Deleting any link in that chain turns these red.
 *
 * WHAT IT CANNOT CATCH: jsdom performs no layout and applies no stylesheet, so
 * `position: sticky` has no observable effect here. These assertions prove the
 * pinning classes REACH the right cells; they cannot prove the cells then stay
 * put under a real scroll. That half is `e2e/branches-pinned-name-column.spec.ts`,
 * which drives a browser, scrolls the container, and compares bounding boxes.
 *
 * The class names are written out as literals rather than imported from
 * `grid-table-pin.ts`, deliberately: importing them would make this test agree
 * with whatever that module currently says, including a `sticky` silently
 * dropped from it.
 */

const ROW: BranchRow = {
  id: "owner%2Fweb::feature",
  branchName: "feature/pinned-name",
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

// The three declarations that together take a cell out of the horizontal
// scroll and stop the columns behind it showing through. Pinned to independent
// literals: a pin that loses its opaque surface still LOOKS pinned in a class
// list, and is unreadable on screen.
const STICKY_CLASS = "sticky";
const LEFT_EDGE_CLASS = "left-0";
const OPAQUE_SURFACE_CLASS = "bg-[var(--grid-table-surface,var(--background))]";
// The lead header's accessible name also carries its sort affordance, so the
// match is on the label rather than the whole string.
const NAME_HEADER_PATTERN = /name/i;

describe("Branches pinned Name column (ISS-6959)", () => {
  it("pins the Name header and body cells when the flag is on", () => {
    renderBranchesTable(true);

    const nameHeader = screen.getByRole("columnheader", {
      name: NAME_HEADER_PATTERN,
    });
    expect(nameHeader).toHaveClass(STICKY_CLASS);
    expect(nameHeader).toHaveClass(LEFT_EDGE_CLASS);
    expect(nameHeader).toHaveClass(OPAQUE_SURFACE_CLASS);

    const nameCell = leadBodyCell();
    expect(nameCell).toHaveClass(STICKY_CLASS);
    expect(nameCell).toHaveClass(LEFT_EDGE_CLASS);
    expect(nameCell).toHaveClass(OPAQUE_SURFACE_CLASS);
  });

  // The sibling that stops the assertions above passing on a component that
  // pins unconditionally: same table, same query, opposite flag, opposite
  // outcome. Without this, a `pinLeadColumn={true}` hardcoded past the flag
  // would keep the first test green.
  it("leaves the Name header and body cells unpinned when the flag is off", () => {
    renderBranchesTable(false);

    const nameHeader = screen.getByRole("columnheader", {
      name: NAME_HEADER_PATTERN,
    });
    expect(nameHeader).not.toHaveClass(STICKY_CLASS);
    expect(nameHeader).not.toHaveClass(LEFT_EDGE_CLASS);

    const nameCell = leadBodyCell();
    expect(nameCell).not.toHaveClass(STICKY_CLASS);
    expect(nameCell).not.toHaveClass(LEFT_EDGE_CLASS);
  });

  // The pinned cell stops moving while its row keeps moving underneath it, so
  // the row's own hover tint cannot be the pinned cell's background — it is 40%
  // opaque, and the columns passing behind would read through it. The tint is
  // restated on an overlay above an opaque surface instead; this pins that the
  // overlay is wired to the ROW's hover (`group-hover`), because a pinned cell
  // that only tints on its own hover leaves the one cell identifying the row as
  // the one cell that does not respond to the row.
  it("carries the row hover tint on an overlay rather than as its background", () => {
    renderBranchesTable(true);

    expect(leadBodyCell()).toHaveClass("group-hover:before:bg-muted/40");
    expect(leadBodyCell()).not.toHaveClass("group-hover:bg-muted/40");
  });
});

function renderBranchesTable(flagOn: boolean) {
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: flagOn
          ? [BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      <BranchesTable approved items={[ROW]} />
    </FeatureFlagAdapterProvider>
  );
}

/**
 * The row's identity cell. Found through the branch name the row renders rather
 * than by class or position, so the query cannot drift onto a different cell as
 * the table's chrome changes.
 */
function leadBodyCell(): HTMLElement {
  const cell = screen
    .getByText(ROW.branchName)
    .closest('[role="cell"], [role="gridcell"]');
  if (!(cell instanceof HTMLElement)) {
    throw new Error("branch name is not inside a table cell");
  }
  return cell;
}

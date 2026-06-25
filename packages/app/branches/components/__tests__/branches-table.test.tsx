import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type BranchRow,
  BranchRowStatus,
  RENDER_MISSING,
  RENDER_UNATTRIBUTED,
} from "../../lib/branch-sample-data";
import { BranchesTable } from "../branches-table";

const fullRow: BranchRow = {
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

const missingRow: BranchRow = {
  id: "local::wip",
  branchName: "wip/local",
  baseBranch: RENDER_MISSING,
  repo: RENDER_MISSING,
  owner: RENDER_UNATTRIBUTED,
  status: BranchRowStatus.Draft,
  prNumber: null,
  prTitle: null,
  prUrl: null,
  prState: null,
  checksPassed: null,
  checksTotal: null,
  checksStatus: null,
  behind: null,
  ahead: null,
  additions: null,
  deletions: null,
  sessionCount: 0,
  commentCount: null,
  lastActivityLabel: "10m ago",
};

const GRID_TEMPLATE_RE = /grid-template-columns:\s*([^;]+)/;

// Count top-level grid tracks, treating a parenthesized function such as
// `minmax(260px, 1fr)` (which contains a space) as a single track.
function countTracks(template: string): number {
  let depth = 0;
  let inToken = false;
  let count = 0;
  for (const ch of template) {
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    }
    if (ch === " " && depth === 0) {
      inToken = false;
    } else if (!inToken) {
      inToken = true;
      count += 1;
    }
  }
  return count;
}

function gridShape(el: Element): { children: number; tracks: number } {
  const match = (el.getAttribute("style") ?? "").match(GRID_TEMPLATE_RE);
  return {
    children: el.children.length,
    tracks: match ? countTracks(match[1]) : 0,
  };
}

describe("BranchesTable grid alignment", () => {
  it("renders exactly one grid cell per template track (no phantom trailing cell)", () => {
    // Regression: a phantom trailing border cell with no template track wrapped
    // onto an implicit grid row and overlaid the first row's name cell, eating
    // its mouse events. Header and data rows must each have cells === tracks.
    render(<BranchesTable items={[fullRow]} />);

    const headerEl = screen.getByText("Branch").closest("div.grid");
    const rowEl = screen.getByText("feature/full").closest("div.grid");
    expect(headerEl).not.toBeNull();
    expect(rowEl).not.toBeNull();

    const header = gridShape(headerEl as Element);
    const row = gridShape(rowEl as Element);
    expect(header.tracks).toBeGreaterThan(0);
    expect(header.children).toBe(header.tracks);
    expect(row.children).toBe(row.tracks);
  });
});

describe("BranchesTable in-scope columns (B4)", () => {
  it("renders exactly the in-scope columns and none of the excluded ones", () => {
    render(<BranchesTable items={[fullRow]} />);
    for (const header of [
      "Branch",
      "Repository",
      "Status",
      "Last active",
      "Linked Sessions",
      "Changes",
      "Pull request",
    ]) {
      expect(screen.getByText(header)).toBeInTheDocument();
    }
    for (const excluded of [
      "Owner",
      "Behind / Ahead",
      "Check status",
      "Story points",
      "Projects",
      "Tags",
      "Issues",
      "Reviewer",
    ]) {
      expect(screen.queryByText(excluded)).not.toBeInTheDocument();
    }
  });

  it("renders a fully-enriched row's cells", () => {
    render(<BranchesTable items={[fullRow]} />);
    expect(screen.getByText("feature/full")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument(); // short repo name
    expect(screen.getByText("web#42")).toBeInTheDocument(); // PR badge
    expect(screen.getByText("+10")).toBeInTheDocument(); // changes
    expect(screen.getByText("−5")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // linked sessions count
  });

  it("degrades github-live cells to the empty-value affordance when absent", () => {
    render(<BranchesTable items={[missingRow]} />);
    // repo, PR, changes, sessions → "—"
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
  });
});

describe("BranchesTable row→detail navigation (C2)", () => {
  it("wraps the Name lead in an anchor to the branch href when provided", () => {
    // missingRow has no PR, so the lead anchor is the only link in the row.
    render(
      <BranchesTable
        getBranchHref={(item) => `#/branches/${item.id}`}
        items={[missingRow]}
      />
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "#/branches/local::wip");
    expect(link).toHaveTextContent("wip/local");
  });

  it("renders a plain (non-link) lead when getBranchHref is omitted", () => {
    render(<BranchesTable items={[missingRow]} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("wip/local")).toBeInTheDocument();
  });

  it("links EVERY row's lead, including the first, not just later rows", () => {
    // Regression guard: the first row's name must be a branch-detail link too.
    // fullRow also renders a PR-badge link (to the PR url), so we isolate the
    // lead anchors by their branch-detail href prefix.
    render(
      <BranchesTable
        getBranchHref={(item) => `#/branches/${item.id}`}
        items={[fullRow, missingRow]}
      />
    );
    const leadHrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"))
      .filter((href) => href?.startsWith("#/branches/"));
    expect(leadHrefs).toContain(`#/branches/${fullRow.id}`);
    expect(leadHrefs).toContain(`#/branches/${missingRow.id}`);
  });
});

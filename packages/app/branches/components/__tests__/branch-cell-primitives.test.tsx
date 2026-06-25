import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BranchBehindAheadBar } from "../branch-behind-ahead-bar";
import { BranchChangesBar } from "../branch-changes-bar";
import { BranchPRBadge } from "../branch-pr-badge";

const EMPTY = "—";
const PR_LINK_RE = /#42/;

describe("BranchBehindAheadBar", () => {
  it("renders both counts when present", () => {
    render(<BranchBehindAheadBar ahead={5} behind={2} />);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
  });

  it("renders the empty-value affordance when either side is null (never 0)", () => {
    render(<BranchBehindAheadBar ahead={null} behind={null} />);
    expect(screen.getByText(EMPTY)).toBeInTheDocument();
  });
});

describe("BranchChangesBar", () => {
  it("renders +additions / −deletions when present", () => {
    render(<BranchChangesBar additions={261} deletions={150} />);
    expect(screen.getByText("+261")).toBeInTheDocument();
    expect(screen.getByText("−150")).toBeInTheDocument();
  });

  it("renders the empty-value affordance when both are null", () => {
    render(<BranchChangesBar additions={null} deletions={null} />);
    expect(screen.getByText(EMPTY)).toBeInTheDocument();
  });
});

describe("BranchPRBadge", () => {
  it("renders the PR number when present", () => {
    render(<BranchPRBadge prNumber={42} prState="OPEN" />);
    expect(screen.getByText(PR_LINK_RE)).toBeInTheDocument();
  });

  it("renders an external link for a canonical GitHub PR URL", () => {
    render(
      <BranchPRBadge
        prNumber={42}
        prState="MERGED"
        prUrl="https://github.com/acme/web/pull/42"
      />
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://github.com/acme/web/pull/42");
  });

  it("does NOT link out for a non-canonical / unsafe URL (renders the chip only)", () => {
    render(
      <BranchPRBadge
        prNumber={42}
        prState="MERGED"
        prUrl="https://gh/acme/web/pull/42"
      />
    );
    expect(screen.getByText(PR_LINK_RE)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders the empty-value affordance when there is no PR", () => {
    render(<BranchPRBadge prNumber={null} />);
    expect(screen.getByText(EMPTY)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

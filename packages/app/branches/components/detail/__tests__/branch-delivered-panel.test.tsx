import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeBranchDetail } from "../../../__tests__/branch-fixtures";
import { BranchDeliveredPanel } from "../branch-delivered-panel";

const WHAT_DELIVERED = "What was delivered";
const NO_ARTIFACTS_RE = /no linked artifacts/i;
const NO_PR_DESC_RE = /no pull request opened yet/i;

describe("BranchDeliveredPanel", () => {
  it("renders the 'What was delivered' header and the linked-artifacts box (box 1)", () => {
    render(<BranchDeliveredPanel detail={makeBranchDetail()} />);
    expect(screen.getByText(WHAT_DELIVERED)).toBeInTheDocument();
    // Box 1 is for linked artifacts (documents/issues), NOT the PR.
    expect(screen.getByText(NO_ARTIFACTS_RE)).toBeInTheDocument();
  });

  it("lists linked Closedloop artifacts (slug) in box 1 when present", () => {
    const detail = makeBranchDetail({
      linkedArtifacts: [{ slug: "FEA-1952" }, { slug: "PLN-988" }],
    });
    render(<BranchDeliveredPanel detail={detail} />);

    expect(screen.getByText("FEA-1952")).toBeInTheDocument();
    expect(screen.getByText("PLN-988")).toBeInTheDocument();
    expect(screen.queryByText(NO_ARTIFACTS_RE)).not.toBeInTheDocument();
  });

  it("renders the PR identity (number, title, state, external link) in box 2", () => {
    const detail = makeBranchDetail({
      prNumber: 42,
      prTitle: "Add the thing",
      prUrl: "https://github.com/octo/repo/pull/42",
      prState: "OPEN",
    });
    render(<BranchDeliveredPanel detail={detail} />);

    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("Add the thing")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/octo/repo/pull/42"
    );
  });

  it("renders the read-only PR description body when present (no composer)", () => {
    const detail = makeBranchDetail({
      prNumber: 7,
      prBody: "This PR does the work.",
    });
    render(<BranchDeliveredPanel detail={detail} />);

    expect(screen.getByText("This PR does the work.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows the no-PR empty state in box 2 while box 1 stays the artifacts box", () => {
    const detail = makeBranchDetail({
      prNumber: null,
      prTitle: null,
      prUrl: null,
      prState: null,
      prBody: null,
      linkedPrNumbers: [],
    });
    render(<BranchDeliveredPanel detail={detail} />);

    expect(screen.getByText(NO_ARTIFACTS_RE)).toBeInTheDocument();
    expect(screen.getByText(NO_PR_DESC_RE)).toBeInTheDocument();
    // No PR → no external link.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

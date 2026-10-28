// ISS-9964 / ISS-9980 (RULED 2026-09-11): the value rendered in the
// session-detail "Lines changed" property row. The row counts MERGED authored
// PRs and nothing else, in every window and filter state and behind no flag.
//
// The FEA-4378 / ISS-4448 cases this file used to carry — the working-tree
// `+added / -removed` shape, the branch-diff shape, the legacy "in PRs"
// caption, and the two flag-gate cases — asserted contracts this change
// RETIRES, not behavior it happens to break. ISS-9980 ruled the rungs out
// (transcript-derived scalars fold delegated sub-agent churn in, and a branch
// spans sessions this one did not author, so neither measures delivered code)
// and deleted the `sessions-merged-loc-rung` flag, so those expectations have
// no subject left. Their deletion is the complete outcome, not a coverage loss.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionOutputDiff } from "../session-output-diff";

describe("SessionOutputDiff (ISS-9964 / ISS-9980)", () => {
  it("renders the merged authored-PR total, uncolored, captioned in merged PRs", () => {
    const { container } = render(
      <SessionOutputDiff
        session={{
          mergedAuthoredPrLinesChanged: 8000,
          authoredPrLinesChanged: 12_000,
        }}
      />
    );

    expect(screen.getByText("8,000")).toBeInTheDocument();
    expect(screen.getByText("in merged PRs")).toBeInTheDocument();
    // The legacy wider figure is not what the row shows, and its older caption
    // is gone with it — one population, one label.
    expect(container.textContent).not.toContain("12,000");
    expect(screen.queryByText("in PRs")).toBeNull();
    // A combined added+removed total must NOT wear the per-side classes: `.add`
    // means "added" everywhere else in this pane and would mis-teach it.
    expect(container.querySelector(".add")).toBeNull();
    expect(container.querySelector(".del")).toBeNull();
  });

  // ISS-9980's zero rule, at the render. A session that merged nothing is a
  // MEASURED fact about the population and prints a real `0` — the placeholder
  // is reserved for what could not be measured at all.
  it("renders a measured zero as 0, not as the unavailable placeholder", () => {
    render(<SessionOutputDiff session={{ mergedAuthoredPrLinesChanged: 0 }} />);

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("in merged PRs")).toBeInTheDocument();
    expect(screen.queryByText("not available")).toBeNull();
  });

  // The other half of that rule, and the reason it exists: a numerator nobody
  // could resolve must not borrow the appearance of one that was. This is the
  // desktop-before-cloud-sync shape ISS-9980 ruled on ("fine if it's not
  // available until we connect to cloud") and ISS-4448's 88-merged-PR session
  // whose per-PR LOC rows are unreachable.
  it("renders the unavailable placeholder when the merged count is not knowable", () => {
    render(<SessionOutputDiff session={{}} />);

    expect(screen.getByText("not available")).toBeInTheDocument();
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.queryByText("in merged PRs")).toBeNull();
  });

  // Cross-repo skew: the pre-rename ISS-6114 key predates the merge gate, so a
  // producer sending only it has told us about a WIDER population. That is not
  // a merged count, and the row says so rather than relabelling it.
  it("renders unavailable when only the legacy pre-merge-gate field is present", () => {
    render(<SessionOutputDiff session={{ authoredPrLinesChanged: 9000 }} />);

    expect(screen.getByText("not available")).toBeInTheDocument();
    expect(screen.queryByText("9,000")).toBeNull();
  });
});

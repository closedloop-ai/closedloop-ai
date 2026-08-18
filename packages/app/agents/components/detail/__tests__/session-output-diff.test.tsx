// FEA-4378: the value rendered in the session-detail "Lines changed" property
// row (its own labeled row, no longer trailing the "Pull requests" pills). Proves
// the rendered number is the authored-PR delivered code (not the bare session
// working-tree diff) when the roll-up exceeds the local diff, that the roll-up
// carries an "in PRs" qualifier, and that the roll-up total is NOT colored with
// the green add class (it is a combined added+removed figure, not "added").

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionOutputDiff } from "../session-output-diff";

describe("SessionOutputDiff (FEA-4378)", () => {
  it("renders the authored-PR delivered LOC, not the bare session diff, when the roll-up is larger", () => {
    const { container } = render(
      <SessionOutputDiff
        session={{
          linesAdded: 134,
          linesRemoved: 2,
          authoredPrLinesChanged: 8000,
        }}
      />
    );

    // The delivered figure is the 8,000-line PR roll-up...
    expect(screen.getByText("8,000")).toBeInTheDocument();
    // ...qualified "in PRs" so it reads as the PRs' code, not the working tree...
    expect(screen.getByText("in PRs")).toBeInTheDocument();
    // ...and NOT the misleading working-tree diff the bug rendered here.
    expect(container.textContent).not.toContain("+134");
    expect(container.textContent).not.toContain("-2");
    expect(container.querySelector(".del")).toBeNull();
    // The combined added+removed total must NOT wear the green `.add` class —
    // that means "added" everywhere else and would mis-teach the combined figure.
    expect(container.querySelector(".add")).toBeNull();
  });

  it("renders the working-tree +added / -removed diff when there is no larger authored-PR roll-up", () => {
    const { container } = render(
      <SessionOutputDiff
        session={{
          linesAdded: 200,
          linesRemoved: 40,
          authoredPrLinesChanged: 0,
        }}
      />
    );

    expect(screen.getByText("+200")).toBeInTheDocument();
    expect(screen.getByText("-40")).toBeInTheDocument();
    // Honest per-side colors are kept for the working-tree diff (add green, del red).
    expect(container.querySelector(".add")).not.toBeNull();
    expect(container.querySelector(".del")).not.toBeNull();
    // ISS-4449: all three shapes carry a scope qualifier so "no caption" is never
    // itself a hidden signal. ISS-5402: that qualifier is "in session", not
    // "working tree" — the scalars behind it are transcript-derived (FEA-3922) and
    // now include a delegated sub-agent's authored lines, so naming the working
    // tree would name a scope this number does not have.
    expect(screen.getByText("in session")).toBeInTheDocument();
    expect(screen.queryByText("working tree")).toBeNull();
  });

  it("falls back to the working-tree shape when authoredPrLinesChanged is absent (desktop/version skew)", () => {
    render(
      <SessionOutputDiff
        session={{
          linesAdded: 50,
          linesRemoved: 10,
          authoredPrLinesChanged: undefined,
        }}
      />
    );

    expect(screen.getByText("+50")).toBeInTheDocument();
    expect(screen.getByText("-10")).toBeInTheDocument();
    expect(screen.getByText("in session")).toBeInTheDocument();
  });

  // ISS-4448: an 88-merged-PR session whose authored-PR LOC path is unreachable
  // (authoredPrLinesChanged = 0) but whose branch diff carries 3315/689. The row
  // must surface the branch diff, NOT the tiny +51 -5 working-tree residual.
  it("renders the branch diff, not the tiny working-tree residual, when the branch diff is materially larger (ISS-4448)", () => {
    const { container } = render(
      <SessionOutputDiff
        session={{
          linesAdded: 51,
          linesRemoved: 5,
          authoredPrLinesChanged: 0,
          branchDiffStats: {
            linesAdded: 3315,
            linesRemoved: 689,
            filesChanged: 42,
            source: "git",
          },
        }}
      />
    );

    // The real shipped branch diff — colored per side, qualified "branch total".
    expect(screen.getByText("+3,315")).toBeInTheDocument();
    expect(screen.getByText("-689")).toBeInTheDocument();
    expect(screen.getByText("branch total")).toBeInTheDocument();
    expect(container.querySelector(".add")).not.toBeNull();
    expect(container.querySelector(".del")).not.toBeNull();
    // The misleading tiny residual is NOT what the row shows.
    expect(container.textContent).not.toContain("+51");
    expect(container.textContent).not.toContain("-5");
  });

  // The authored-PR roll-up stays the most authoritative signal: even with a
  // branch diff present, a larger authored-PR total wins (no regression of the
  // FEA-4378 case).
  it("prefers the authored-PR roll-up over the branch diff when it is the largest signal", () => {
    render(
      <SessionOutputDiff
        session={{
          linesAdded: 51,
          linesRemoved: 5,
          authoredPrLinesChanged: 9000,
          branchDiffStats: {
            linesAdded: 3315,
            linesRemoved: 689,
            filesChanged: 42,
            source: "git",
          },
        }}
      />
    );

    expect(screen.getByText("9,000")).toBeInTheDocument();
    expect(screen.getByText("in PRs")).toBeInTheDocument();
  });

  // A normal session whose local working-tree diff is the largest real signal is
  // unchanged — no branch-diff or authored-PR shape hijacks the honest residual.
  it("keeps the working-tree diff when it is the largest signal (branch diff smaller)", () => {
    render(
      <SessionOutputDiff
        session={{
          linesAdded: 200,
          linesRemoved: 40,
          authoredPrLinesChanged: 0,
          branchDiffStats: {
            linesAdded: 10,
            linesRemoved: 3,
            filesChanged: 1,
            source: "git",
          },
        }}
      />
    );

    expect(screen.getByText("+200")).toBeInTheDocument();
    expect(screen.getByText("-40")).toBeInTheDocument();
    expect(screen.getByText("in session")).toBeInTheDocument();
  });

  // ISS-5402: a delegating session's own scalars now carry its folded sub-agents'
  // authored lines, so they can exceed BOTH shipped-code signals — golden f7441d99
  // went 345 -> 5313 on that fold. The row is allowed to resolve to the session
  // rung there (largest-wins exists so it can never understate), but it must say
  // which scope it picked: this asserts the big number does NOT render under a
  // caption claiming the PRs' delivered code or the branch total.
  it("labels the session's own churn as such when the fold makes it exceed both shipped-code signals (ISS-5402)", () => {
    render(
      <SessionOutputDiff
        session={{
          linesAdded: 4306,
          linesRemoved: 1007,
          authoredPrLinesChanged: 900,
          branchDiffStats: {
            linesAdded: 300,
            linesRemoved: 45,
            filesChanged: 19,
            source: "git",
          },
        }}
      />
    );

    expect(screen.getByText("+4,306")).toBeInTheDocument();
    expect(screen.getByText("-1,007")).toBeInTheDocument();
    expect(screen.getByText("in session")).toBeInTheDocument();
    expect(screen.queryByText("in PRs")).toBeNull();
    expect(screen.queryByText("branch total")).toBeNull();
  });
});

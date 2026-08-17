// ISS-4769: the session-detail "Pull requests" row and its empty state.
//
// The row lists only the PRs the session AUTHORED (referenced/reviewed links are
// filtered out upstream, and ISS-4768 extends that to the desktop-reported legacy
// blob), so the bare "None" it used to render was read as "nothing was delivered"
// beside a real "Lines changed" figure. "None authored" names what the lane
// actually computed, and it ships unconditionally as of ISS-5366 (the
// `session-loc-pr-attribution` gate retired to its enabled state).

import type { SessionPR } from "@repo/api/src/types/agent-session";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SESSION_EMPTY_PULL_REQUESTS_LABEL } from "../detail-content";
import { SessionPullRequestsRow } from "../session-pull-requests-row";

const REPO = "closedloop-ai/symphony-alpha";

function renderRow({ prs }: { prs: readonly SessionPR[] }) {
  return render(<SessionPullRequestsRow prs={prs} repositoryFullName={REPO} />);
}

describe("SessionPullRequestsRow (ISS-4769)", () => {
  // The ISS-4769 report shape: session 019fa44c reading "Pull requests: None"
  // beside a real "Lines changed" figure and several linked FEATs. The row must
  // render the CANONICAL label, not a string re-declared at the call site, and
  // regressing to the bare "None" turns the second assertion red.
  it("names the empty row with the canonical authored-none label", () => {
    renderRow({ prs: [] });

    expect(
      screen.getByText(SESSION_EMPTY_PULL_REQUESTS_LABEL)
    ).toBeInTheDocument();
    expect(screen.queryByText("None")).not.toBeInTheDocument();
  });

  // The copy is an EMPTY-state label, never a caption on a populated row: with a
  // PR present neither spelling may appear.
  it("renders the pills and no empty-state copy when a PR is attributed", () => {
    renderRow({ prs: [{ num: 7, title: "PR #7", status: "merged" }] });

    expect(screen.getByText("7")).toBeInTheDocument();
    expect(
      screen.queryByText(SESSION_EMPTY_PULL_REQUESTS_LABEL)
    ).not.toBeInTheDocument();
    expect(screen.queryByText("None")).not.toBeInTheDocument();
  });
});

// The copy itself, pinned in ONE place. The row above asserts it renders the
// constant; this asserts the constant still says the word that makes the row
// reconcile with "Lines changed" — a silent edit back to a bare "None" would
// otherwise satisfy both render assertions.
describe("SESSION_EMPTY_PULL_REQUESTS_LABEL (ISS-4769)", () => {
  it("names the authored scope rather than an unqualified none", () => {
    expect(SESSION_EMPTY_PULL_REQUESTS_LABEL).toBe("None authored");
  });
});

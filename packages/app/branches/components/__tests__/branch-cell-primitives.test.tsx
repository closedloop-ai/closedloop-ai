import { GitHubPRState } from "@repo/api/src/types/github-status";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  BRANCH_PULL_REQUEST_UNCONFIRMED_EXPLANATION,
  BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL,
} from "../../lib/branch-outcome-copy";
import { BranchBehindAheadBar } from "../branch-behind-ahead-bar";
import { BranchChangesBar } from "../branch-changes-bar";
import { BranchPRBadge } from "../branch-pr-badge";
import { BRANCH_UNAVAILABLE_LABEL } from "../branch-unavailable-value";

const EMPTY = "—";
const PR_LINK_RE = /#42/;
// The state word and its sentence must BOTH reach the accessible name: the word
// alone is a chip whose meaning a screen reader cannot resolve, and the sentence
// alone is the hue-only failure with extra steps.
const UNCONFIRMED_NAME_RE =
  /Unconfirmed[\s\S]*GitHub hasn't reported this pull request's state yet/;

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

  it("renders the unavailable word when both are null", () => {
    render(<BranchChangesBar additions={null} deletions={null} />);
    expect(screen.getByText(BRANCH_UNAVAILABLE_LABEL)).toBeInTheDocument();
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

  // ISS-8422: a PR number with no state is a PR nobody observed. It is neither a
  // lifecycle state nor "no PR", and the row still links out — so it may render
  // neither a state word nor the empty-value dash.
  it("states an unobserved PR in words, keeping the number and dropping no row", () => {
    render(<BranchPRBadge prNumber={42} prState={null} repoShortName="web" />);
    expect(screen.getByText(PR_LINK_RE)).toBeInTheDocument();
    expect(
      screen.getByText(BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL)
    ).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
  });

  // The composition neither ticket's own suite covers: ISS-7362's split (repo
  // prefix truncates, number is `shrink-0`) carrying ISS-8422's word. An earlier
  // draft of ISS-8422 dropped the prefix for this state to buy room; ISS-7362
  // made that unnecessary, so the prefix stays and the word is a third item that
  // may shrink but the number still may not.
  it("keeps the repo prefix and the number beside the unobserved word", () => {
    const { container } = render(
      <BranchPRBadge prNumber={42} prState={null} repoShortName="web" />
    );

    expect(container.textContent).toContain("web#42");
    expect(screen.getByText("#42")).toBeInTheDocument();
    const truncating = container.querySelectorAll(".truncate");
    expect(truncating[0]).toHaveTextContent("web");
    expect(truncating[0]?.textContent).not.toContain("42");
    expect(
      screen.getByText(BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL)
    ).toBeInTheDocument();
  });

  it("puts the unobserved state in the accessible name, not only the hue", () => {
    render(
      <BranchPRBadge
        prNumber={42}
        prState={null}
        prUrl="https://github.com/acme/web/pull/42"
        repoShortName="web"
      />
    );
    const link = screen.getByRole("link");
    // ISS-7362 gave the linked arm an `aria-label`, which REPLACES a
    // content-derived name — so the `sr-only` tail alone would have been
    // silently dropped here. The label states the sentence itself.
    expect(link).toHaveAccessibleName(UNCONFIRMED_NAME_RE);
    // ONE home for the sentence. Putting it in `title` as well made it the
    // accessible DESCRIPTION, so a screen reader read it inside the name and
    // then again straight after — the ISS-7737 defect. `title` names the pull
    // request, as it does for every other state.
    expect(link).not.toHaveAccessibleDescription(
      BRANCH_PULL_REQUEST_UNCONFIRMED_EXPLANATION
    );
    expect(link).toHaveAttribute("title", "web#42");
  });

  // The OTHER arm. `aria-label` only exists on the linked chip, so the non-link
  // arm's name comes from its contents and it is the `sr-only` tail that has to
  // carry the sentence there. Nothing asserted it, while the component comment
  // claimed both arms were covered.
  it("states the unobserved sentence on the NON-linked arm too", () => {
    render(
      <BranchPRBadge
        prNumber={42}
        prState={null}
        prUrl="https://gh/acme/web/pull/42"
        repoShortName="web"
      />
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(
      screen.getByText(BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL)
    ).toBeInTheDocument();
    expect(
      screen.getByText(`, ${BRANCH_PULL_REQUEST_UNCONFIRMED_EXPLANATION}`, {
        exact: false,
      })
    ).toHaveClass("sr-only");
  });

  it("does NOT say unconfirmed for an observed state", () => {
    render(<BranchPRBadge prNumber={42} prState="OPEN" repoShortName="web" />);
    expect(
      screen.queryByText(BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL)
    ).not.toBeInTheDocument();
  });

  // ISS-7362. jsdom has no layout, so what is pinned here is the structural
  // property that makes the elision impossible: `truncate` (text-overflow:
  // ellipsis) can only ever eat the tail of the node it sits on, so the PR
  // number surviving at any width is exactly "the number is not inside that
  // node". A single-span label (the reverted implementation) fails both
  // assertions below.
  it("keeps the PR number out of the truncating node so a narrow column cannot elide it", () => {
    const { container } = render(
      <BranchPRBadge
        prNumber={4242}
        prState={GitHubPRState.Open}
        repoShortName="acme/frontend"
      />
    );

    const truncating = container.querySelectorAll(".truncate");
    expect(truncating).toHaveLength(1);
    expect(truncating[0]).toHaveTextContent("acme/frontend");
    expect(truncating[0]?.textContent).not.toContain("4242");
    expect(screen.getByText("#4242")).toBeInTheDocument();
    // DOM text only — that the split introduced no whitespace text node. That
    // the two boxes also render flush (a `gap` on their wrapper would split the
    // label visually and leave this green) is measured in
    // `e2e/branches-pr-number-truncation.spec.ts`, where there is a layout.
    expect(container.textContent).toContain("acme/frontend#4242");
  });

  // The two halves are separate flex items, and a name-from-content walk may
  // join them with a space. `aria-label` is what actually holds the link's name
  // to the single `repo#number` token it read before the split, so it is
  // asserted through the accessibility tree rather than through textContent.
  it("names the linked chip with the whole repo#number label, unsplit", () => {
    render(
      <BranchPRBadge
        prNumber={4242}
        prState={GitHubPRState.Open}
        prTitle="Wire the frontend"
        prUrl="https://github.com/acme/frontend/pull/4242"
        repoShortName="acme/frontend"
      />
    );

    expect(
      screen.getByRole("link", { name: "acme/frontend#4242" })
    ).toBeInTheDocument();
  });

  it("renders the number alone — and nothing truncating — when there is no repo prefix", () => {
    const { container } = render(
      <BranchPRBadge prNumber={4242} prState={GitHubPRState.Open} />
    );

    expect(container.querySelectorAll(".truncate")).toHaveLength(0);
    expect(screen.getByText("#4242")).toBeInTheDocument();
  });
});

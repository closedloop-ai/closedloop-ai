import {
  type BranchAssociatedPullRequestCollection,
  BranchAssociatedPullRequestCompletenessReason,
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BranchPullRequestSelector } from "../branch-pull-request-selector";

const BETA_OPTION_RE = /#42 Same number.*beta\/widgets.*Open/i;
const INCOMPLETE_DESCRIPTION_RE =
  /some pull request history couldn't be verified/i;
const UNAVAILABLE_DESCRIPTION_RE = /pull request history isn't available yet/i;
const UNCONFIRMED_OPTION_RE = /#42 Same number.*alpha\/widgets.*Unconfirmed/i;
const UNCONFIRMED_DESCRIPTION_RE =
  /github hasn't reported this pull request's state yet/i;

describe("BranchPullRequestSelector", () => {
  it("emits the exact repository-qualified identity for the selected PR", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <BranchPullRequestSelector
        collection={collection()}
        onChange={onChange}
        selectedId="alpha/widgets#42"
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Pull request" }));
    await user.click(screen.getByRole("option", { name: BETA_OPTION_RE }));

    expect(onChange).toHaveBeenCalledWith({
      repositoryFullName: "beta/widgets",
      pullRequestNumber: 42,
    });
  });

  it("discloses incomplete history without disabling known options", () => {
    render(
      <BranchPullRequestSelector
        collection={collection(
          BranchAssociatedPullRequestCompletenessState.Incomplete
        )}
        onChange={() => undefined}
        selectedId="alpha/widgets#42"
      />
    );

    expect(
      screen.getByRole("combobox", { name: "Pull request" })
    ).toBeEnabled();
    expect(screen.getByText(INCOMPLETE_DESCRIPTION_RE)).toBeInTheDocument();
  });

  it("disables an empty unavailable selector and explains the missing history", () => {
    const value = collection(
      BranchAssociatedPullRequestCompletenessState.Unavailable
    );
    value.items = [];
    value.selectedId = null;
    render(
      <BranchPullRequestSelector
        collection={value}
        onChange={() => undefined}
        selectedId={null}
      />
    );

    expect(
      screen.getByRole("combobox", { name: "Pull request" })
    ).toBeDisabled();
    expect(screen.getByText(UNAVAILABLE_DESCRIPTION_RE)).toBeInTheDocument();
  });

  // ISS-8422: the wire item still reports the `OPEN` it read off its column
  // default, so this control confidently labelled an unobserved PR "Open". The
  // per-item flag is the only thing that separates the two, and a sibling in the
  // same dropdown must keep its real label.
  it("labels an unobserved option Unconfirmed, leaving an observed sibling Open", async () => {
    const user = userEvent.setup();
    const value = collection();
    value.items = [
      { ...pullRequest("alpha/widgets"), lifecycleObserved: false },
      pullRequest("beta/widgets"),
    ];
    render(
      <BranchPullRequestSelector
        collection={value}
        onChange={() => undefined}
        selectedId="alpha/widgets#42"
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Pull request" }));

    expect(
      screen.getByRole("option", { name: UNCONFIRMED_OPTION_RE })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: BETA_OPTION_RE })
    ).toBeInTheDocument();
  });

  // ISS-8422 follow-up: keying the sentence off `selectionReason` alone lost it
  // exactly when a reader had chosen the unobserved pull request themselves.
  // `selectionReason` says why the CONTRACT picked a default, so a reader's own
  // pick reads `Explicit` (desktop sets precisely that), and in a multi-PR
  // collection with an observed default it is never `Unobserved` at all.
  it("explains an unobserved selection the reader chose, whose reason is Explicit", () => {
    const value = collection();
    value.selectionReason = BranchAssociatedPullRequestSelectionReason.Explicit;
    value.items = [
      { ...pullRequest("alpha/widgets"), lifecycleObserved: false },
      pullRequest("beta/widgets"),
    ];
    render(
      <BranchPullRequestSelector
        collection={value}
        onChange={() => undefined}
        selectedId="alpha/widgets#42"
      />
    );

    expect(screen.getByText(UNCONFIRMED_DESCRIPTION_RE)).toBeInTheDocument();
  });

  // The observed sibling in that same collection is the counterfactual: the
  // sentence follows the SELECTED item, so selecting the observed one says
  // nothing even though an unobserved row is still in the list.
  it("stays quiet when the selected item is the observed sibling", () => {
    const value = collection();
    value.selectionReason = BranchAssociatedPullRequestSelectionReason.Explicit;
    value.items = [
      { ...pullRequest("alpha/widgets"), lifecycleObserved: false },
      pullRequest("beta/widgets"),
    ];
    render(
      <BranchPullRequestSelector
        collection={value}
        onChange={() => undefined}
        selectedId="beta/widgets#42"
      />
    );

    expect(screen.queryByText(UNCONFIRMED_DESCRIPTION_RE)).toBeNull();
  });

  it("explains an unobserved SELECTION, which reports Complete and would say nothing", () => {
    const value = collection();
    value.selectionReason =
      BranchAssociatedPullRequestSelectionReason.Unobserved;
    render(
      <BranchPullRequestSelector
        collection={value}
        onChange={() => undefined}
        selectedId="alpha/widgets#42"
      />
    );

    // Completeness is deliberately Complete for this case (adding a reason
    // degraded an org-wide KPI), so a description keyed on completeness alone
    // renders nothing and every card below the control looks merely empty.
    expect(value.completeness.state).toBe(
      BranchAssociatedPullRequestCompletenessState.Complete
    );
    expect(screen.getByText(UNCONFIRMED_DESCRIPTION_RE)).toBeInTheDocument();
  });
});

function collection(
  state: BranchAssociatedPullRequestCompletenessState = BranchAssociatedPullRequestCompletenessState.Complete
): BranchAssociatedPullRequestCollection {
  return {
    items: [pullRequest("alpha/widgets"), pullRequest("beta/widgets")],
    selectedId: "alpha/widgets#42",
    selectionReason: BranchAssociatedPullRequestSelectionReason.Active,
    completeness: {
      state,
      reasons:
        state === BranchAssociatedPullRequestCompletenessState.Complete
          ? []
          : [BranchAssociatedPullRequestCompletenessReason.InvalidIdentity],
      provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
    },
  };
}

function pullRequest(repositoryFullName: string) {
  return {
    id: `${repositoryFullName}#42`,
    repositoryFullName,
    number: 42,
    title: "Same number",
    url: `https://github.com/${repositoryFullName}/pull/42`,
    state: GitHubPRState.Open,
    isDraft: false,
    reviewDecision: null,
    openedAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
  };
}

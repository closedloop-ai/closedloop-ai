import {
  type BranchAssociatedPullRequestCollection,
  BranchAssociatedPullRequestCompletenessReason,
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { BranchPullRequestSelector } from "./branch-pull-request-selector";

const completeCollection = makeCollection(
  BranchAssociatedPullRequestCompletenessState.Complete
);

const meta = {
  title: "Composites/Branches/Pull Request Selector",
  component: BranchPullRequestSelector,
  tags: ["autodocs"],
  argTypes: {
    collection: { control: "object" },
    disabled: { control: "boolean" },
    selectedId: { control: "text" },
    onChange: { control: false, table: { category: "Events" } },
  },
  parameters: { layout: "padded" },
  args: {
    collection: completeCollection,
    disabled: false,
    onChange: fn(),
    selectedId: completeCollection.selectedId,
  },
} satisfies Meta<typeof BranchPullRequestSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Complete: Story = {};

export const Incomplete: Story = {
  args: {
    collection: makeCollection(
      BranchAssociatedPullRequestCompletenessState.Incomplete
    ),
  },
};

export const UnavailableWithKnownPullRequests: Story = {
  args: {
    collection: makeCollection(
      BranchAssociatedPullRequestCompletenessState.Unavailable
    ),
  },
};

export const EmptyDisabled: Story = {
  args: {
    collection: {
      ...makeCollection(
        BranchAssociatedPullRequestCompletenessState.Unavailable
      ),
      items: [],
      selectedId: null,
    },
    selectedId: null,
  },
};

function makeCollection(
  state: BranchAssociatedPullRequestCompletenessState
): BranchAssociatedPullRequestCollection {
  return {
    items: [
      makePullRequest("closedloop-ai/symphony-alpha", 4473, "Open", false),
      makePullRequest("closedloop-ai/desktop", 4473, "Draft", true),
      makePullRequest("closedloop-ai/symphony-alpha", 4401, "Merged", false),
    ],
    selectedId: "closedloop-ai/symphony-alpha#4473",
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

function makePullRequest(
  repositoryFullName: string,
  number: number,
  lifecycle: "Draft" | "Merged" | "Open",
  isDraft: boolean
) {
  return {
    id: `${repositoryFullName}#${number}`,
    repositoryFullName,
    number,
    title: `${lifecycle} pull request`,
    url: `https://github.com/${repositoryFullName}/pull/${number}`,
    state: lifecycle === "Merged" ? GitHubPRState.Merged : GitHubPRState.Open,
    isDraft,
    reviewDecision: null,
    openedAt: "2026-08-01T00:00:00.000Z",
    closedAt: lifecycle === "Merged" ? "2026-08-03T00:00:00.000Z" : null,
    mergedAt: lifecycle === "Merged" ? "2026-08-03T00:00:00.000Z" : null,
  };
}

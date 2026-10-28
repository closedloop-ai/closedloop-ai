import {
  BranchLinkedArtifactCollectionProvenance,
  BranchLinkedArtifactCollectionState,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { makeBranchDetail } from "../../__tests__/branch-fixtures";
import { BranchDeliveredPanel } from "./branch-delivered-panel";

const HEAD_SHA = "b".repeat(40);

/** Linked-artifact completeness and selected-PR attribution matrix. */
const meta = {
  title: "Composites v1.0/Branches/Branch Delivered Panel",
  component: BranchDeliveredPanel,
  tags: ["deprecated", "autodocs"],
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BranchDeliveredPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CompleteWithNoLinkedArtifacts: Story = {
  args: {
    detail: selectedPullRequestDetail([], {
      state: BranchLinkedArtifactCollectionState.Complete,
      provenance: BranchLinkedArtifactCollectionProvenance.CloudPersisted,
    }),
  },
};

export const IncompleteWithNoVerifiedArtifacts: Story = {
  args: {
    detail: detailWithCollection(
      BranchLinkedArtifactCollectionState.Incomplete
    ),
  },
};

export const ArtifactCompletenessUnavailable: Story = {
  args: {
    detail: detailWithCollection(
      BranchLinkedArtifactCollectionState.Unavailable
    ),
  },
};

export const SelectedPullRequestOverridesBranchCompatibilityFields: Story = {
  args: {
    detail: selectedPullRequestDetail([{ slug: "ISS-4473" }], {
      state: BranchLinkedArtifactCollectionState.Complete,
      provenance: BranchLinkedArtifactCollectionProvenance.CloudPersisted,
    }),
  },
};

/**
 * ISS-8241: the base-ref and author line is closed by default, so without this
 * decorator every story below renders the shipped box and the two states this
 * work exists to produce are unviewable.
 */
const withBaseAndAuthor: Decorator = (Story) => (
  <FeatureFlagAdapterProvider
    adapter={createStaticFeatureFlagAdapter({
      enabledFlags: [BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FEATURE_FLAG_KEY],
    })}
  >
    <Story />
  </FeatureFlagAdapterProvider>
);

export const MeasuredBaseAndAuthor: Story = {
  decorators: [withBaseAndAuthor],
  args: {
    detail: selectedPullRequestDetail([{ slug: "ISS-8241" }], {
      state: BranchLinkedArtifactCollectionState.Complete,
      provenance: BranchLinkedArtifactCollectionProvenance.CloudPersisted,
    }),
  },
};

/** What every signed-out Desktop branch shows: the local lane measures neither. */
export const UnmeasuredBaseAndAuthor: Story = {
  decorators: [withBaseAndAuthor],
  args: {
    detail: (() => {
      const detail = selectedPullRequestDetail([{ slug: "ISS-8241" }], {
        state: BranchLinkedArtifactCollectionState.Complete,
        provenance: BranchLinkedArtifactCollectionProvenance.CloudPersisted,
      });
      return {
        ...detail,
        selectedPullRequest: detail.selectedPullRequest
          ? {
              ...detail.selectedPullRequest,
              authorLogin: null,
              baseRefName: null,
            }
          : null,
      };
    })(),
  },
};

function detailWithCollection(state: BranchLinkedArtifactCollectionState) {
  return makeBranchDetail({
    linkedArtifacts: [],
    linkedArtifactsCollection: {
      state,
      provenance: BranchLinkedArtifactCollectionProvenance.CloudPersisted,
    },
  });
}

function selectedPullRequestDetail(
  linkedArtifacts: { slug: string }[],
  linkedArtifactsCollection: {
    state: BranchLinkedArtifactCollectionState;
    provenance: BranchLinkedArtifactCollectionProvenance;
  }
) {
  return makeBranchDetail({
    prNumber: 7,
    prTitle: "Default pull request",
    prUrl: "https://github.com/octo/repo/pull/7",
    prState: GitHubPRState.Closed,
    prBody: "Default pull request body.",
    selectedPullRequest: {
      id: "octo/repo#42",
      repositoryFullName: "octo/repo",
      number: 42,
      title: "Selected historical pull request",
      url: "https://github.com/octo/repo/pull/42",
      state: GitHubPRState.Merged,
      isDraft: false,
      reviewDecision: null,
      openedAt: "2026-07-01T00:00:00.000Z",
      closedAt: "2026-07-03T00:00:00.000Z",
      mergedAt: "2026-07-03T00:00:00.000Z",
      body: `## Summary

The selected pull request includes **formatted delivery evidence**.

- [x] Preserve selected-PR scoping
- [x] Share rendering across web and Desktop

[Review on GitHub](https://github.com/octo/repo/pull/42)

![Architecture diagram](https://example.com/architecture.png)

<!-- goal-orchestrator-workflow
work_item: ISS-4783
-->`,
      baseRefName: "main",
      authorLogin: "octocat",
      headRefOid: HEAD_SHA,
      mergeCommitSha: "c".repeat(40),
      changedFiles: 3,
      additions: 18,
      deletions: 4,
    },
    linkedArtifacts,
    linkedArtifactsCollection,
  });
}

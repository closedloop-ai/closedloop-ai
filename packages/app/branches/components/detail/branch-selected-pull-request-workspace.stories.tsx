import {
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { makeBranchDetail } from "../../__tests__/branch-fixtures";
import type { BranchesDataSource } from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import {
  completeMetrics,
  completePhaseAttribution,
  completeSelectedPullRequest,
} from "../branch-story-metric-fixtures";
import { BranchSelectedPullRequestWorkspace } from "./branch-selected-pull-request-workspace";

const LOADING_BRANCH_ID = "workspace-switch-loading";
const MISMATCH_BRANCH_ID = "workspace-selection-mismatch";
const selectedPullRequest = completeSelectedPullRequest();
const historicalPullRequest = {
  id: "owner/repo#1260",
  repositoryFullName: "owner/repo",
  number: 1260,
  title: "Earlier Branch Details attempt",
  url: "https://github.com/owner/repo/pull/1260",
  state: GitHubPRState.Closed,
  isDraft: false,
  reviewDecision: null,
  openedAt: "2026-06-12T09:00:00.000Z",
  closedAt: "2026-06-12T11:00:00.000Z",
  mergedAt: null,
};
const targetSelection = {
  repositoryFullName: historicalPullRequest.repositoryFullName,
  pullRequestNumber: historicalPullRequest.number,
};

const baseDetail = makeBranchDetail({
  id: "workspace-story-base",
  branchName: "feature/branches-detail",
  repoFullName: "owner/repo",
  status: BranchStatus.Merged,
  prNumber: selectedPullRequest.number,
  prTitle: selectedPullRequest.title,
  prState: selectedPullRequest.state,
  prUrl: selectedPullRequest.url,
  estimatedCostUsd: 4,
  additions: 180,
  deletions: 24,
  filesChanged: 3,
  openedAt: selectedPullRequest.openedAt,
  closedAt: selectedPullRequest.closedAt,
  mergedAt: selectedPullRequest.mergedAt,
  associatedPullRequests: {
    items: [selectedPullRequest, historicalPullRequest],
    selectedId: selectedPullRequest.id,
    selectionReason:
      BranchAssociatedPullRequestSelectionReason.MostRecentTerminal,
    completeness: {
      state: BranchAssociatedPullRequestCompletenessState.Complete,
      reasons: [],
      provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
    },
  },
  selectedPullRequest,
  canonicalMetrics: completeMetrics(),
  phaseAttribution: completePhaseAttribution(),
});

const workspaceSource: BranchesDataSource = {
  scope: "workspace-state-story",
  list: () => Promise.reject(new Error("list unused")),
  detail: (id) =>
    id === LOADING_BRANCH_ID
      ? pendingDetail()
      : Promise.resolve({ ...baseDetail, id: MISMATCH_BRANCH_ID }),
  comments: () => Promise.reject(new Error("comments unused")),
  trace: () => Promise.reject(new Error("trace unused")),
  usage: () => Promise.reject(new Error("usage unused")),
  analytics: () => Promise.reject(new Error("analytics unused")),
  pageData: () => Promise.reject(new Error("page data unused")),
};

const meta = {
  title: "Composites/Branches/Branch Selected Pull Request Workspace",
  component: BranchSelectedPullRequestWorkspace,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <BranchesDataSourceProvider dataSource={workspaceSource}>
        <div className="mx-auto h-[640px] w-full max-w-[1000px] overflow-auto px-5 pb-6">
          <Story />
        </div>
      </BranchesDataSourceProvider>
    ),
  ],
  argTypes: {
    analytics: { control: "object", table: { category: "Data" } },
    branchId: {
      control: "text",
      description:
        "Drives the detail and comments reads through the data source.",
      table: { category: "Data" },
    },
    detail: { control: "object", table: { category: "Data" } },
    getArtifactHref: { control: false, table: { category: "Data" } },
    loc: {
      control: "object",
      description: "Pre-resolved changed-LOC. Null members mean unavailable.",
      table: { category: "Data" },
    },
    onCommentsContextChange: {
      control: false,
      table: { category: "Events" },
    },
    onSelectionChange: { control: false, table: { category: "Events" } },
    queryIdentity: { control: "object", table: { category: "Data" } },
    selection: {
      control: "object",
      description:
        "Explicit historical-PR selection. Null reads the branch's own selected PR.",
      table: { category: "Data" },
    },
  },
  args: {
    detail: baseDetail,
    onCommentsContextChange: fn(),
    onSelectionChange: fn(),
    selection: targetSelection,
  },
} satisfies Meta<typeof BranchSelectedPullRequestWorkspace>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Explicit historical-PR selection keeps every selector-dependent panel hidden while loading. */
export const SwitchLoading: Story = {
  args: { branchId: LOADING_BRANCH_ID },
};

/** A successful response for the wrong PR falls back to Branch-owned cost only. */
export const SelectionMismatch: Story = {
  args: { branchId: MISMATCH_BRANCH_ID },
};

function pendingDetail(): Promise<BranchPageDetail> {
  return new Promise(() => undefined);
}

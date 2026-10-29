import {
  type BranchDataState,
  BranchProvenance,
  BranchTagAvailability,
} from "@repo/api/src/types/branch";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import {
  type Priority,
  Priority as PriorityValue,
} from "@repo/api/src/types/common";
import { GitHubPRState } from "@repo/api/src/types/github";
import { TagColor } from "@repo/api/src/types/tag";
import {
  type BranchRow,
  BranchRowStatus,
  RENDER_UNATTRIBUTED,
} from "../lib/branch-row";

export const PreviewBranchStatus = { Canceled: "canceled" } as const;
export type PreviewBranchStatus =
  | BranchRow["status"]
  | (typeof PreviewBranchStatus)[keyof typeof PreviewBranchStatus];
export const PreviewPullRequestState = GitHubPRState;
type PreviewPullRequestState = GitHubPRState | null;

export type PreviewBranchRowInput = {
  id: string;
  branchName: string;
  baseBranch: string;
  repo: string;
  owner: string | null;
  status: PreviewBranchStatus;
  provenance?: BranchProvenance;
  prNumber: number | null;
  prTitle: string | null;
  prUrl: string | null;
  prState: PreviewPullRequestState;
  checksPassed: number | null;
  checksTotal: number | null;
  additions: number | null;
  deletions: number | null;
  sessionCount: number;
  commentCount: number | null;
  lastActivityAt: string;
  lastActivityLabel: string;
  collaborators?: readonly string[];
  tags?: readonly string[];
  priority?: string | null;
  dataState?: BranchDataState;
  projectId?: string | null;
  projectName?: string | null;
};

/** Project mock-friendly row values into the canonical Branch row contract. */
export function createPreviewBranchRow(
  input: PreviewBranchRowInput
): BranchRow {
  return {
    additions: input.additions,
    ahead: null,
    baseBranch: input.baseBranch,
    behind: null,
    branchName: input.branchName,
    canonicalIdentity: input.id,
    checksPassed: input.checksPassed,
    checksStatus: previewChecksStatus(input),
    checksTotal: input.checksTotal,
    collaborators: (input.collaborators ?? []).map((name) => ({
      key: `preview:${name.toLowerCase().replaceAll(" ", "-")}`,
      name,
    })),
    commentCount: input.commentCount,
    dataState: input.dataState,
    deletions: input.deletions,
    hasPullRequest: input.prNumber !== null,
    id: input.id,
    lastActivityAt: input.lastActivityAt,
    lastActivityLabel: input.lastActivityLabel,
    owner: input.owner ?? RENDER_UNATTRIBUTED,
    ownerKey: input.owner ?? RENDER_UNATTRIBUTED,
    priority: previewPriority(input.priority),
    projectId: input.projectId ?? null,
    projectName: input.projectName ?? null,
    provenance: input.provenance ?? BranchProvenance.Human,
    prNumber: input.prNumber,
    prRepo: input.prNumber === null ? null : input.repo,
    prState: previewPullRequestState(input.prState),
    prTitle: input.prTitle,
    prUrl: input.prUrl,
    repo: input.repo,
    rawStatus: input.status,
    sessionCount: input.sessionCount,
    status:
      input.status === PreviewBranchStatus.Canceled
        ? BranchRowStatus.Closed
        : input.status,
    tagAvailability: BranchTagAvailability.Available,
    tags: (input.tags ?? []).map((name, index) => ({
      color:
        PREVIEW_TAG_COLORS[index % PREVIEW_TAG_COLORS.length] ?? TagColor.Blue,
      id: `preview-tag:${name.toLowerCase().replaceAll(" ", "-")}`,
      name,
    })),
  };
}

function previewChecksStatus({
  checksPassed,
  checksTotal,
}: Pick<PreviewBranchRowInput, "checksPassed" | "checksTotal">) {
  if (checksTotal === null) {
    return null;
  }
  if (checksPassed === null) {
    return ChecksStatus.Pending;
  }
  return checksPassed === checksTotal
    ? ChecksStatus.Passing
    : ChecksStatus.Failing;
}

function previewPullRequestState(state: PreviewPullRequestState) {
  if (state === GitHubPRState.Open) {
    return GitHubPRState.Open;
  }
  if (state === GitHubPRState.Merged) {
    return GitHubPRState.Merged;
  }
  if (state === GitHubPRState.Closed) {
    return GitHubPRState.Closed;
  }
  return null;
}

function previewPriority(
  value: string | null | undefined
): Priority | undefined | null {
  if (value === null || value === undefined) {
    return value;
  }
  if (
    value === PriorityValue.Low ||
    value === PriorityValue.Medium ||
    value === PriorityValue.High ||
    value === PriorityValue.Urgent
  ) {
    return value;
  }
  return undefined;
}

const PREVIEW_TAG_COLORS = [
  TagColor.Blue,
  TagColor.Violet,
  TagColor.Teal,
  TagColor.Amber,
] as const;

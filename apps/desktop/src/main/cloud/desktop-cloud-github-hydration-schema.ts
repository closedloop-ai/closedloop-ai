import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import {
  GitHubPRState,
  GitHubRepositorySource,
} from "@repo/api/src/types/github";
import { z } from "zod";
import type { CloudHydrationOverlayResponse } from "./desktop-cloud-github-eligibility-overlays.js";
import {
  cloudPullRequestAuthorityShape,
  cloudRepositoryAuthorityShape,
} from "./desktop-cloud-repository-default-authority.js";

/** Treat every advertised continuation or full first page as incomplete. */
export function isIncompletePullRequestResponse(
  response: CloudPullRequestsResponse,
  pageCap: number
): boolean {
  return (
    response.hasMore === true ||
    response.truncated === true ||
    response.pageInfo?.hasNextPage === true ||
    response.pullRequests.length >= pageCap ||
    (response.stopReason !== undefined && response.stopReason !== "complete")
  );
}

export type CloudRepository = z.infer<typeof cloudRepositorySchema>;
export type CloudBranch = z.infer<typeof cloudBranchSchema>;
export type CloudPullRequest = z.infer<typeof cloudPullRequestSchema>;
export type CloudPullRequestsResponse = z.infer<
  typeof cloudPullRequestsResponseSchema
>;
export type CloudHydrationResponse = CloudHydrationOverlayResponse & {
  repository: CloudRepository;
  branches: CloudBranch[];
  pullRequests: CloudPullRequest[];
};

const cloudRepositorySchema = z
  .object({
    id: z.string(),
    fullName: z.string(),
    githubRepoId: z.string().trim().min(1),
    source: z.enum(GitHubRepositorySource),
    ...cloudRepositoryAuthorityShape,
  })
  .passthrough();
export const cloudRepositoriesSchema = z.array(cloudRepositorySchema);
const cloudBranchSchema = z
  .object({
    name: z.string(),
    committedDate: z.string(),
  })
  .passthrough();
export const cloudBranchesResponseSchema = z
  .object({
    branches: z.array(cloudBranchSchema),
  })
  .passthrough();
const cloudPullRequestSchema = z
  .object({
    number: z.number(),
    title: z.string(),
    htmlUrl: z.string(),
    headBranch: z.string(),
    baseBranch: z.string(),
    state: z.enum([
      GitHubPRState.Open,
      GitHubPRState.Closed,
      GitHubPRState.Merged,
    ]),
    mergedAt: z.string().nullable().optional(),
    updatedAt: z.string(),
    author: z.string(),
    additions: z.number().nullable().optional(),
    deletions: z.number().nullable().optional(),
    changedFiles: z.number().nullable().optional(),
    checksStatus: z
      .enum([
        ChecksStatus.Unknown,
        ChecksStatus.Pending,
        ChecksStatus.Passing,
        ChecksStatus.Failing,
      ])
      .nullable()
      .optional(),
    reviewDecision: z
      .enum([
        ReviewDecision.Approved,
        ReviewDecision.ChangesRequested,
        ReviewDecision.Commented,
        ReviewDecision.Dismissed,
      ])
      .nullable()
      .optional(),
    ...cloudPullRequestAuthorityShape,
  })
  .passthrough();
export const cloudPullRequestsResponseSchema = z
  .object({
    pullRequests: z.array(cloudPullRequestSchema),
    hasMore: z.boolean().optional(),
    truncated: z.boolean().optional(),
    pageInfo: z
      .object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
      .optional(),
    stopReason: z.string().optional(),
  })
  .passthrough();

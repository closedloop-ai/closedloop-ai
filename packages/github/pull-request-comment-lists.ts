import type { Octokit } from "@octokit/rest";
import {
  type GitHubCommentAuthor,
  type GitHubPullRequestIssueComment,
  type GitHubPullRequestReview,
  type GitHubPullRequestReviewComment,
  mapGitHubCommentAuthor,
  mapPullRequestIssueComment,
  mapPullRequestReview,
  mapPullRequestReviewComment,
} from "./comment-payloads";
import { toGitHubProviderFailure } from "./provider-error-classification";
import {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
} from "./provider-result";
import {
  type GitHubPageBounds,
  type GitHubPageRead,
  readPullRequestIssueCommentPages,
  readPullRequestReviewCommentPages,
  readPullRequestReviewPages,
} from "./pull-request-comment-pages";
import { readReviewThreadMetadata } from "./review-thread-lookup";

/** PLN-2122 decision 4: at most 50 pages of 100 rows (5,000 rows) per list. */
export const MAX_COMPLETE_LIST_PAGES = 50;
/**
 * Every GraphQL request one review-thread read may make, thread pages and
 * per-thread comment pages together. Past the first, each request covers 100
 * more review comments (a thread holds at least one), so a pull request with
 * at most 5,000 review comments needs at most 50.
 */
export const MAX_REVIEW_THREAD_METADATA_REQUESTS = 50;
const COMPLETE_LIST_BOUNDS: GitHubPageBounds = {
  pageSize: 100,
  maxPages: MAX_COMPLETE_LIST_PAGES,
  verifyStable: true,
};

/**
 * Every row the provider returned. `complete` is false when the page ceiling
 * stopped the read, or when a deletion mid-read may have shifted a row past
 * the pages read (`shifted`), so a row missing from `items` is not evidence of
 * deletion.
 */
export type GitHubCompleteList<T> = GitHubPageRead<T>;

export async function listAllPullRequestIssueComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<
  GitHubProviderResult<GitHubCompleteList<GitHubPullRequestIssueComment>>
> {
  try {
    const list = await readPullRequestIssueCommentPages(
      octokit,
      owner,
      repo,
      pullNumber,
      COMPLETE_LIST_BOUNDS
    );
    return {
      status: GitHubProviderResultStatus.Success,
      value: {
        items: list.items.map(mapPullRequestIssueComment),
        complete: list.complete,
        ...(list.shifted ? { shifted: list.shifted } : {}),
      },
    };
  } catch (error) {
    return toGitHubProviderFailure(error);
  }
}

/**
 * Review comments with their review-thread id and resolution. The list is
 * complete only when the review-thread read also reached its last page.
 */
export async function listAllPullRequestReviewComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<
  GitHubProviderResult<GitHubCompleteList<GitHubPullRequestReviewComment>>
> {
  try {
    const list = await readPullRequestReviewCommentPages(
      octokit,
      owner,
      repo,
      pullNumber,
      COMPLETE_LIST_BOUNDS
    );
    const threads = await readReviewThreadMetadata(
      octokit,
      owner,
      repo,
      pullNumber,
      {
        maxPagesPerConnection: Number.POSITIVE_INFINITY,
        maxRequests: MAX_REVIEW_THREAD_METADATA_REQUESTS,
      }
    );
    return {
      status: GitHubProviderResultStatus.Success,
      value: {
        items: list.items.map((comment) => {
          const thread = threads.metadataByCommentId.get(comment.id);
          return mapPullRequestReviewComment(
            comment,
            thread?.id ?? null,
            thread?.isResolved ?? null
          );
        }),
        complete: list.complete && threads.complete,
        ...(list.shifted ? { shifted: list.shifted } : {}),
      },
    };
  } catch (error) {
    return toGitHubProviderFailure(error);
  }
}

/**
 * A review with its author's full identity. The established review DTO keeps
 * only the login and avatar; a stored review summary is attributed to the same
 * provider identity the review webhook names, which needs the GitHub user id.
 */
export type GitHubPullRequestReviewWithAuthor = GitHubPullRequestReview & {
  author: GitHubCommentAuthor | null;
};

export async function listAllPullRequestReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<
  GitHubProviderResult<GitHubCompleteList<GitHubPullRequestReviewWithAuthor>>
> {
  try {
    const list = await readPullRequestReviewPages(
      octokit,
      owner,
      repo,
      pullNumber,
      COMPLETE_LIST_BOUNDS
    );
    return {
      status: GitHubProviderResultStatus.Success,
      value: {
        items: list.items.map((review) => ({
          ...mapPullRequestReview(review),
          author: mapGitHubCommentAuthor(review.user),
        })),
        complete: list.complete,
        ...(list.shifted ? { shifted: list.shifted } : {}),
      },
    };
  } catch (error) {
    return toGitHubProviderFailure(error);
  }
}

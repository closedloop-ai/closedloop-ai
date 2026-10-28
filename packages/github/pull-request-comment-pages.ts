import type { Octokit } from "@octokit/rest";

/**
 * One paged REST read: request pages of `pageSize` rows until a short page or
 * `maxPages`, then truncate to `limit` rows when one is given.
 */
export type GitHubPageBounds = {
  pageSize: number;
  maxPages: number;
  limit?: number;
  /**
   * Re-read every page before the last once the read ends, and call the list
   * complete only if each returned the same rows ({@link readPages}).
   */
  verifyStable?: boolean;
};

/**
 * `complete` is true only when a short page proved the provider has no more
 * rows, `limit` dropped none of them, and (with `verifyStable`) no row before
 * the last page went away mid-read. `shifted` marks a read that failed only
 * that last check.
 */
export type GitHubPageRead<T> = {
  items: T[];
  complete: boolean;
  shifted?: true;
};

export function readPullRequestIssueCommentPages(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  bounds: GitHubPageBounds
) {
  return readPages(async (page, perPage) => {
    const { data } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
      per_page: perPage,
      page,
    });
    return data;
  }, bounds);
}

export function readPullRequestReviewCommentPages(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  bounds: GitHubPageBounds
) {
  return readPages(async (page, perPage) => {
    const { data } = await octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: perPage,
      page,
    });
    return data;
  }, bounds);
}

export function readPullRequestReviewPages(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  bounds: GitHubPageBounds
) {
  return readPages(async (page, perPage) => {
    const { data } = await octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: perPage,
      page,
    });
    return data;
  }, bounds);
}

/**
 * `per_page` stays fixed across pages: GitHub computes the offset as
 * `(page - 1) * per_page`, so shrinking the last page reads the wrong rows.
 * The same offset arithmetic skips a row when an earlier one is deleted
 * between two page requests, while the read still ends on a short page. These
 * lists are oldest first and new rows land on the last page, so a skip shows
 * as an earlier page that no longer returns the rows it did; `verifyStable`
 * re-reads those pages to catch it.
 */
async function readPages<T extends { id: number }>(
  readPage: (page: number, perPage: number) => Promise<T[]>,
  { pageSize, maxPages, limit, verifyStable }: GitHubPageBounds
): Promise<GitHubPageRead<T>> {
  const items: T[] = [];
  const pageIds: number[][] = [];
  for (let page = 1; page <= maxPages; page++) {
    const rows = await readPage(page, pageSize);
    items.push(...rows);
    pageIds.push(rows.map((row) => row.id));
    if (rows.length < pageSize) {
      if (
        verifyStable &&
        !(await earlierPagesUnchanged(readPage, pageSize, pageIds))
      ) {
        return { items, complete: false, shifted: true };
      }
      return truncateToLimit(items, true, limit);
    }
    if (limit !== undefined && items.length >= limit) {
      break;
    }
  }
  return truncateToLimit(items, false, limit);
}

function truncateToLimit<T>(
  items: T[],
  complete: boolean,
  limit: number | undefined
): GitHubPageRead<T> {
  if (limit === undefined || items.length <= limit) {
    return { items, complete };
  }
  return { items: items.slice(0, limit), complete: false };
}

async function earlierPagesUnchanged<T extends { id: number }>(
  readPage: (page: number, perPage: number) => Promise<T[]>,
  pageSize: number,
  pageIds: readonly number[][]
): Promise<boolean> {
  for (let index = 0; index < pageIds.length - 1; index++) {
    const rows = await readPage(index + 1, pageSize);
    const before = pageIds[index] ?? [];
    if (
      rows.length !== before.length ||
      rows.some((row, position) => row.id !== before[position])
    ) {
      return false;
    }
  }
  return true;
}

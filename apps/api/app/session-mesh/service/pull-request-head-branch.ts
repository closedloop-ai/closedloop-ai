import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import type { SessionMeshPublishInput } from "@repo/api/src/types/session-mesh";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * The head branch of the pull request a published message names, read from
 * this organization's own GitHub PR records.
 *
 * Operator decision on #8592 (2026-10-08, option B): a reviewer's
 * "Reviewing PR-N" row reaches the PR author's session through the PR's head
 * branch, because the author's presence carries the branch it is on and never
 * the PR number unless the author typed it.
 *
 * Returns `undefined` for anything it cannot establish: a PR value that is not
 * `#<number>`, a Mesh repository that is not a github.com one, no matching
 * record, a record with no provider-reported head ref, a head in another
 * repository (a fork's branch name means nothing to this repository's
 * sessions), or a failed read. Each of those leaves routing as it was without
 * this lookup. The read runs outside the publish transaction so a failure here
 * cannot abort the publish.
 */
const PULL_REQUEST_PATTERN = /^#(\d{1,7})$/;
const GITHUB_REPOSITORY_PREFIX = "github.com/";

export async function resolvePullRequestHeadBranch(input: {
  organizationId: string;
  repository: string;
  lineage: SessionMeshPublishInput["lineage"];
}): Promise<string | undefined> {
  const digits = PULL_REQUEST_PATTERN.exec(
    input.lineage.pullRequest ?? ""
  )?.[1];
  const repository = input.repository.toLowerCase();
  if (!(digits && repository.startsWith(GITHUB_REPOSITORY_PREFIX))) {
    return undefined;
  }
  const repositoryFullName = normalizeRepoFullName(
    repository.slice(GITHUB_REPOSITORY_PREFIX.length)
  );
  try {
    const record = await withDb((db) =>
      db.pullRequestDetail.findFirst({
        where: {
          organizationId: input.organizationId,
          repositoryFullName,
          number: Number(digits),
          headRefName: { not: null },
        },
        select: { headRefName: true, headRepositoryFullName: true },
        // Not `isCurrent`: that is the retired branch-to-PR pointer (ISS-8521).
        orderBy: [
          { githubUpdatedAt: { sort: "desc", nulls: "last" } },
          { id: "asc" },
        ],
      })
    );
    if (
      record?.headRepositoryFullName &&
      normalizeRepoFullName(record.headRepositoryFullName) !==
        repositoryFullName
    ) {
      return undefined;
    }
    return record?.headRefName ?? undefined;
  } catch (error) {
    log.warn("session mesh pull request head branch lookup failed", {
      organizationId: input.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

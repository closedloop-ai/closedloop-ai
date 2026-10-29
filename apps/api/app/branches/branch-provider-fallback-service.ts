import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import { ArtifactType, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { parseGitHubPullRequestUrl } from "@/app/artifact-links/pull-requests/pull-request-url";

type ProviderPullRequest = {
  htmlUrl: string | null;
  number: number;
  repositoryFullName: string | null;
};

/**
 * Batch-project whether Branches have the exact provider PR fallback accepted
 * by the legacy compatibility resolver. Failures omit every optional signal.
 */
export const branchProviderFallbackService = {
  async findByIds(
    organizationId: string,
    branchIds: readonly string[]
  ): Promise<ReadonlySet<string>> {
    const ids = Array.from(new Set(branchIds));
    if (ids.length === 0) {
      return new Set();
    }

    try {
      const branchIdsWithFallback = new Set<string>();
      for (const batch of chunks(ids, BRANCH_PROVIDER_FALLBACK_BATCH_SIZE)) {
        const rows = await withDb((db) =>
          db.artifact.findMany({
            where: {
              id: { in: batch },
              organizationId,
              type: ArtifactType.BRANCH,
              branch: { deletedAt: null },
            },
            select: {
              id: true,
              branch: {
                select: {
                  currentPullRequestDetail: {
                    select: {
                      htmlUrl: true,
                      number: true,
                      repositoryFullName: true,
                    },
                  },
                },
              },
            },
          })
        );
        for (const row of rows) {
          if (
            matchingGitHubPullRequestUrl(row.branch?.currentPullRequestDetail)
          ) {
            branchIdsWithFallback.add(row.id);
          }
        }
      }
      return branchIdsWithFallback;
    } catch (error) {
      log.warn("telemetry.enrichment_failed", {
        enrichmentKind: "branch_provider_fallback",
        errorClass:
          error instanceof Error ? error.constructor.name : "UnknownError",
        requestedBranchCount: ids.length,
      });
      return new Set();
    }
  },
};

/**
 * Return a persisted PR URL only when its URL identity matches the selected
 * repository and PR number.
 */
export function matchingGitHubPullRequestUrl(
  pullRequest: ProviderPullRequest | null | undefined
): string | null {
  if (!(pullRequest?.htmlUrl && pullRequest.repositoryFullName)) {
    return null;
  }
  const parsed = parseGitHubPullRequestUrl(pullRequest.htmlUrl);
  if (
    !parsed ||
    parsed.number !== pullRequest.number ||
    normalizeRepoFullName(parsed.fullName) !==
      normalizeRepoFullName(pullRequest.repositoryFullName)
  ) {
    return null;
  }
  return pullRequest.htmlUrl;
}

const BRANCH_PROVIDER_FALLBACK_BATCH_SIZE = 500;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

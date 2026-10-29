import type {
  GitHubDirtyScope,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
import { log } from "@repo/observability/log";
import type { GitHubDirtyScopeBatch } from "@/app/integrations/github/dirty-scope-service";
import { githubDirtyScopeService } from "@/app/integrations/github/dirty-scope-service";

export type GitHubDirtyScopePublicationInput = {
  organizationId: string;
  repositoryId: string;
  repositoryFullName?: string;
  scopes: GitHubDirtyScope[];
  triggers?: GitHubDirtyTrigger[];
};

/**
 * Resolves the per-organization prerequisites of a dirty-scope publish once, so
 * a caller publishing for many repositories of one org pays the org-wide target
 * read and the expired-nudge sweep once instead of once per repository
 * (ISS-7276).
 *
 * Best-effort like the publish itself: a failure returns `undefined`, which
 * makes each publish resolve its own targets again rather than skipping the
 * pull hints entirely.
 */
export async function prepareGitHubDirtyScopeBatch(
  organizationId: string
): Promise<GitHubDirtyScopeBatch | undefined> {
  try {
    return await githubDirtyScopeService.prepareBatch(organizationId);
  } catch (error) {
    log.warn(
      "[prepareGitHubDirtyScopeBatch] Failed to prepare dirty-scope batch",
      {
        organizationId,
        error: error instanceof Error ? error.message : "unknown error",
      }
    );
    return undefined;
  }
}

/**
 * Publishes a best-effort Desktop pull hint after webhook-owned projection
 * writes have completed. Failures stay non-fatal because visible reads and app
 * focus remain the recovery path for missed nudges.
 *
 * @param batch Pass the result of `prepareGitHubDirtyScopeBatch` when
 *   publishing for many repositories of the same organization; omit for a lone
 *   publish.
 */
export async function publishGitHubDirtyScopes(
  input: GitHubDirtyScopePublicationInput,
  batch?: GitHubDirtyScopeBatch
): Promise<void> {
  try {
    await githubDirtyScopeService.publish(input, batch);
  } catch (error) {
    log.warn("[publishGitHubDirtyScopes] Failed to publish dirty scopes", {
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      scopeCount: input.scopes.length,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
}

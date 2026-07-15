import type {
  GitHubDirtyScope,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
import { log } from "@repo/observability/log";
import { githubDirtyScopeService } from "@/app/integrations/github/dirty-scope-service";

export type GitHubDirtyScopePublicationInput = {
  organizationId: string;
  repositoryId: string;
  repositoryFullName?: string;
  scopes: GitHubDirtyScope[];
  triggers?: GitHubDirtyTrigger[];
};

/**
 * Publishes a best-effort Desktop pull hint after webhook-owned projection
 * writes have completed. Failures stay non-fatal because visible reads and app
 * focus remain the recovery path for missed nudges.
 */
export async function publishGitHubDirtyScopes(
  input: GitHubDirtyScopePublicationInput
): Promise<void> {
  try {
    await githubDirtyScopeService.publish(input);
  } catch (error) {
    log.warn("[publishGitHubDirtyScopes] Failed to publish dirty scopes", {
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      scopeCount: input.scopes.length,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
}

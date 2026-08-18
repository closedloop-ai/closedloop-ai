import {
  GitHubAccessDenialReason,
  type GitHubCredentialKind,
} from "@repo/api/src/types/github";
import {
  type Result as DomainResult,
  Result,
} from "@repo/api/src/types/result";
import type { Octokit } from "@repo/github/user-token-auth";
import {
  type GitHubAccessError,
  GitHubAccessIntent,
  mapGitHubReadFailureToDenial,
} from "@/lib/github/github-access";
import { getGitHubClient } from "@/lib/github/github-client-resolver";

/**
 * PLN-1525: read-credential resolution for Branch View render reads. Reads run
 * as the requesting user (`read-as-user`) or not at all — a denial is returned
 * for the route to surface as remediation UX.
 *
 * There is deliberately no installation-credential fallback. The installation
 * can reach every repository the GitHub App was installed on, while an org
 * member's own GitHub account may reach none of them; serving a denied user
 * through the installation credential let Closedloop org membership stand in
 * for GitHub repository access. Removing it (the PRD-562 strictness decision)
 * makes what a user can read here exactly what they can read on GitHub.
 */

export type BranchViewReadClient = {
  octokit: Octokit;
  kind: GitHubCredentialKind;
};

export type ResolveBranchViewReadClientInput = {
  organizationId: string;
  userId: string;
  target: { owner: string; repo: string };
};

export async function resolveBranchViewReadClient(
  input: ResolveBranchViewReadClientInput
): Promise<DomainResult<BranchViewReadClient, GitHubAccessError>> {
  const resolved = await getGitHubClient({
    organizationId: input.organizationId,
    userId: input.userId,
    target: input.target,
    intent: GitHubAccessIntent.ReadAsUser,
  });
  if (!resolved.ok) {
    return Result.err(resolved.error);
  }
  return Result.ok({
    octokit: resolved.value.octokit,
    kind: resolved.value.kind,
  });
}

/**
 * Resolve the Branch View read client and run `read` through it.
 *
 * A client that passed resolution can still be denied by GitHub at request
 * time, because resolution may have been served from a cached positive verdict
 * that went stale inside its freshness window (access revoked, repo unshared).
 * Two shapes of that:
 *
 * - a thrown 401/403, classified by the shared reader-failure mapping; and
 * - a result the caller flags via `looksCloaked`. GitHub answers 404 — not 403
 *   — for a private repo a credential cannot see, so a lost-access read is
 *   indistinguishable from a genuinely absent file at this layer. Only the
 *   caller knows which outcomes are implausible enough to distrust.
 *
 * Both surface as `no_installation` rather than an empty diff, so the UI can
 * say "you don't have access" instead of quietly rendering nothing. The stale
 * positive verdict is left to expire on its own short TTL; re-probing it from
 * here would need resolver-internal connection identity that this module has
 * no other reason to hold.
 */
export async function runBranchViewRead<T>(
  input: ResolveBranchViewReadClientInput,
  read: (octokit: Octokit) => Promise<T>,
  looksCloaked?: (result: T) => boolean
): Promise<DomainResult<T, GitHubAccessError>> {
  const client = await resolveBranchViewReadClient(input);
  if (!client.ok) {
    return client;
  }
  let result: T;
  try {
    result = await read(client.value.octokit);
  } catch (error) {
    return Result.err(mapGitHubReadFailureToDenial(error, Date.now()));
  }
  if (looksCloaked?.(result)) {
    return Result.err({
      reason: GitHubAccessDenialReason.NoInstallation,
    });
  }
  return Result.ok(result);
}

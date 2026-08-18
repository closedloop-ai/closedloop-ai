import {
  type GitHubInstallationRepository,
  GitHubInstallationStatus,
  withDb,
} from "@repo/database";
import { verifyBranchExists } from "@repo/github";
import { getInstallationOctokit } from "@repo/github/installation-auth";
import type { Octokit } from "@repo/github/user-token-auth";
import { log } from "@repo/observability/log";
import { BranchNotFoundError, UnauthorizedRepoError } from "./loop-errors";

/**
 * Verify the GitHub App installation has access to every repo in `additionalRepos`.
 * Performs a single batch query against GitHubInstallationRepository scoped to
 * the org's ACTIVE installation. Throws UnauthorizedRepoError if any repos are
 * not accessible. Returns the verified repository records on success.
 *
 * @param additionalRepos - List of repos to check (each with a fullName field)
 * @param organizationId - Organization ID used to scope the installation lookup
 */
export async function authorizeAdditionalRepos(
  additionalRepos: Array<{ fullName: string; branch: string }>,
  organizationId: string
): Promise<AuthorizedInstallationRepository[]> {
  if (additionalRepos.length === 0) {
    return [];
  }

  const fullNames = additionalRepos.map((r) => r.fullName);

  log.info("authorizeAdditionalRepos: checking repos", {
    count: additionalRepos.length,
    repos: fullNames,
    organizationId,
  });

  // Filter tombstoned rows (PLN-634) so dispatch never targets a repo that
  // disappeared from the installation during a disconnect/reinstall window.
  const authorizedRepos = await withDb((db) =>
    db.gitHubInstallationRepository.findMany({
      where: {
        fullName: { in: fullNames },
        removedAt: null,
        installation: {
          organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: {
        id: true,
        fullName: true,
        name: true,
        owner: true,
        private: true,
        githubRepoId: true,
        installationId: true,
        lastPushedAt: true,
        removedAt: true,
        createdAt: true,
        updatedAt: true,
        installation: {
          select: {
            installationId: true,
          },
        },
      },
    })
  );

  const authorizedNames = new Set(authorizedRepos.map((r) => r.fullName));
  const unauthorizedRepos = fullNames.filter((n) => !authorizedNames.has(n));

  if (unauthorizedRepos.length > 0) {
    log.warn("authorizeAdditionalRepos: unauthorized repos detected", {
      unauthorizedRepos,
      organizationId,
    });
    throw new UnauthorizedRepoError(unauthorizedRepos);
  }

  // Build a lookup map so we can find the branch for each authorized repo
  const branchByFullName = new Map(
    additionalRepos.map((r) => [r.fullName, r.branch])
  );

  // Resolve one client per distinct installation before the fan-out. Minting
  // inside the concurrent map makes every repo on a shared installation race
  // for the same cold-cache token, issuing N identical token requests.
  const octokitByInstallation = new Map<string, Octokit>();
  for (const installationId of new Set(
    authorizedRepos.map((repo) => repo.installation.installationId)
  )) {
    octokitByInstallation.set(
      installationId,
      await getInstallationOctokit(installationId)
    );
  }

  await Promise.all(
    authorizedRepos.map(async (repo) => {
      const branch = branchByFullName.get(repo.fullName);
      if (!branch) {
        return;
      }
      const octokit = octokitByInstallation.get(
        repo.installation.installationId
      );
      if (!octokit) {
        return;
      }
      const exists = await verifyBranchExists(
        octokit,
        repo.owner,
        repo.name,
        branch
      );
      if (!exists) {
        log.warn("authorizeAdditionalRepos: branch not found", {
          repo: repo.fullName,
          branch,
          organizationId,
        });
        throw new BranchNotFoundError(repo.fullName, branch);
      }
    })
  );

  log.info("authorizeAdditionalRepos: authorization succeeded", {
    count: authorizedRepos.length,
    repos: authorizedRepos.map((r) => r.fullName),
    organizationId,
  });

  return authorizedRepos;
}

type AuthorizedInstallationRepository = Pick<
  GitHubInstallationRepository,
  | "id"
  | "fullName"
  | "name"
  | "owner"
  | "private"
  | "githubRepoId"
  | "installationId"
  | "lastPushedAt"
  | "removedAt"
  | "createdAt"
  | "updatedAt"
> & { installation: { installationId: string } };

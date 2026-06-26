import type { GetBranchesResponse } from "@repo/api/src/types/github";
import { Result, Status } from "@repo/api/src/types/result";
import type { PublicRepository } from "@repo/database";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";

type GitHubRepoApiResponse = {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  html_url: string;
  private: boolean;
};

// Regex patterns for GitHub URL parsing
const PROTOCOL_PATTERN = /^https?:\/\//i;
const WWW_PREFIX_PATTERN = /^www\./i;
const GIT_SUFFIX_PATTERN = /\.git$/i;
const TRAILING_SLASH_PATTERN = /\/+$/;
const EMBEDDED_BRANCH_DATA_PATTERN =
  /<script type="application\/json" data-target="react-app\.embeddedData">(?<data>.*?)<\/script>/s;
const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;
const GITHUB_BRANCHES_PAGE_HEADERS = {
  Accept: "text/html,application/xhtml+xml",
} as const;

const publicGitHubBranchSchema = z.object({
  name: z.string(),
  authoredDate: z.string(),
  isDefault: z.boolean(),
});

const publicGitHubBranchesPageSchema = z.object({
  payload: z.object({
    current_page: z.number().int().positive(),
    has_more: z.boolean(),
    per_page: z.number().int().positive(),
    branches: z.array(publicGitHubBranchSchema),
  }),
  appPayload: z.object({
    repo: z.object({
      defaultBranch: z.string(),
    }),
  }),
});

function extractEmbeddedBranchData(html: string) {
  const match = EMBEDDED_BRANCH_DATA_PATTERN.exec(html);
  if (!match?.groups?.data) {
    throw new Error(
      "GitHub branches page did not include embedded branch data"
    );
  }

  const parsed = JSON.parse(match.groups.data) as unknown;
  return publicGitHubBranchesPageSchema.parse(parsed);
}

async function fetchPublicBranchesPage(
  owner: string,
  name: string,
  page: number
) {
  const response = await fetch(
    `https://github.com/${owner}/${name}/branches/active?page=${page}`,
    {
      headers: GITHUB_BRANCHES_PAGE_HEADERS,
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub branches page: ${response.status}`);
  }

  return extractEmbeddedBranchData(await response.text());
}

async function getPublicRepositoryBranches(
  owner: string,
  name: string,
  limit = 20
): Promise<GetBranchesResponse["branches"]> {
  const branches: GetBranchesResponse["branches"] = [];
  const seenBranchNames = new Set<string>();
  let page = 1;
  let hasMore = true;
  let defaultBranchName: string | null = null;

  while (branches.length < limit && hasMore) {
    const branchPage = await fetchPublicBranchesPage(owner, name, page);
    defaultBranchName ??= branchPage.appPayload.repo.defaultBranch;

    for (const branch of branchPage.payload.branches) {
      if (seenBranchNames.has(branch.name)) {
        continue;
      }
      seenBranchNames.add(branch.name);
      branches.push({
        name: branch.name,
        committedDate: branch.authoredDate,
        isDefault: branch.isDefault,
      });
    }

    hasMore = branchPage.payload.has_more;
    page += 1;
  }

  branches.sort(
    (a, b) =>
      new Date(b.committedDate).getTime() - new Date(a.committedDate).getTime()
  );

  const resolvedDefaultBranchName = defaultBranchName ?? "main";
  const defaultBranchIndex = branches.findIndex(
    (branch) => branch.name === resolvedDefaultBranchName
  );

  if (defaultBranchIndex > 0) {
    const [defaultBranch] = branches.splice(defaultBranchIndex, 1);
    branches.unshift({ ...defaultBranch, isDefault: true });
  } else if (defaultBranchIndex === 0) {
    branches[0] = { ...branches[0], isDefault: true };
  } else {
    branches.unshift({
      name: resolvedDefaultBranchName,
      committedDate: new Date(0).toISOString(),
      isDefault: true,
    });
  }

  return branches.slice(0, limit);
}

/**
 * Parse a GitHub repository URL or owner/repo string into owner and name.
 *
 * Accepts:
 * - `https://github.com/owner/repo`
 * - `github.com/owner/repo`
 * - `www.github.com/owner/repo`
 * - `owner/repo`
 *
 * Returns `null` if the input cannot be resolved to an owner/name pair.
 */
export function parseGitHubRepoUrl(
  url: string
): { owner: string; name: string } | null {
  // Strip protocol (https://, http://)
  let normalized = url.trim().replace(PROTOCOL_PATTERN, "");

  // Strip www. prefix
  normalized = normalized.replace(WWW_PREFIX_PATTERN, "");

  // Strip trailing slashes and .git suffix
  normalized = normalized
    .replace(GIT_SUFFIX_PATTERN, "")
    .replace(TRAILING_SLASH_PATTERN, "");

  // If starts with github.com/, strip host prefix
  if (normalized.toLowerCase().startsWith("github.com/")) {
    normalized = normalized.slice("github.com/".length);
  }

  // Now we expect exactly owner/repo
  const parts = normalized.split("/");
  if (parts.length !== 2) {
    return null;
  }

  const [owner, name] = parts;
  if (!(owner && name)) {
    return null;
  }

  return { owner, name };
}

export const publicRepositoryService = {
  /**
   * Add a public GitHub repository to the organization.
   *
   * Validates the URL, confirms the repo is public and accessible via the
   * GitHub API (unauthenticated), then creates a PublicRepository record.
   *
   * Returns:
   * - `Result.err(Status.BadRequest)` if the URL is not parseable
   * - `Result.err(Status.NotFound)` if GitHub returns 404
   * - `Result.ok(repo)` on success
   */
  async addPublicRepository(
    organizationId: string,
    url: string
  ): Promise<Result<PublicRepository>> {
    const parsed = parseGitHubRepoUrl(url);
    if (!parsed) {
      log.warn("[public-repositories] Failed to parse GitHub repo URL", {
        url,
      });
      return Result.err(Status.BadRequest);
    }

    const { owner, name } = parsed;

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${name}`,
      {
        headers: GITHUB_API_HEADERS,
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        log.warn("[public-repositories] GitHub repo not found or not public", {
          owner,
          name,
          status: response.status,
        });
        return Result.err(Status.NotFound);
      }

      log.error("[public-repositories] GitHub API error", {
        owner,
        name,
        status: response.status,
      });
      return Result.err(Status.Error);
    }

    const repoData = (await response.json()) as GitHubRepoApiResponse;

    try {
      const repo = await withDb((db) =>
        db.publicRepository.create({
          data: {
            organizationId,
            githubRepoId: String(repoData.id),
            fullName: repoData.full_name,
            owner: repoData.owner.login,
            name: repoData.name,
            htmlUrl: repoData.html_url,
          },
        })
      );

      log.info("[public-repositories] Added public repository", {
        organizationId,
        fullName: repoData.full_name,
      });

      return Result.ok(repo);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        return Result.err(Status.Conflict);
      }
      throw error;
    }
  },

  /**
   * Remove a public repository record by id scoped to the organization.
   */
  async removePublicRepository(
    organizationId: string,
    id: string
  ): Promise<void> {
    await withDb((db) =>
      db.publicRepository.deleteMany({ where: { id, organizationId } })
    );

    log.info("[public-repositories] Removed public repository", {
      organizationId,
      id,
    });
  },

  /**
   * List all public repositories for the organization.
   */
  getPublicRepositories(organizationId: string): Promise<PublicRepository[]> {
    return withDb((db) =>
      db.publicRepository.findMany({
        where: { organizationId },
        orderBy: { createdAt: "desc" },
      })
    );
  },

  /**
   * Fetch active branches for a public GitHub repository without GitHub App auth.
   */
  async getBranches(
    repositoryId: string,
    organizationId: string,
    limit = 20
  ): Promise<GetBranchesResponse> {
    const repository = await withDb((db) =>
      db.publicRepository.findFirst({
        where: {
          id: repositoryId,
          organizationId,
        },
      })
    );

    if (!repository) {
      throw new Error("Repository not found");
    }

    try {
      const branches = await getPublicRepositoryBranches(
        repository.owner,
        repository.name,
        limit
      );

      return { branches };
    } catch (error) {
      log.error("[public-repositories] Failed to fetch public repo branches", {
        repositoryId,
        organizationId,
        fullName: repository.fullName,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw new Error("Failed to fetch branches from GitHub");
    }
  },
};

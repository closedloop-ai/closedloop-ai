import { parseRepositoryFullName } from "@repo/api/src/types/branch-repository";
import {
  type GetBranchesResponse,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import { RepositoryDefaultSource } from "@repo/api/src/types/repository-default-identity";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import type { PublicRepository } from "@repo/database";
import { withDb } from "@repo/database";
import { boundedFetch } from "@repo/github/bounded-fetch";
import { log } from "@repo/observability/log";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { getPrismaErrorCode } from "@/lib/db-utils";
import {
  extractGitHubHttpStatus,
  GitHubAccessIntent,
} from "@/lib/github/github-access";
import { getGitHubClient } from "@/lib/github/github-client-resolver";
import {
  mapGitHubRepositoryDefaultAuthority,
  repositoryDefaultAuthorityPersistenceData,
} from "@/lib/github/repository-default-authority";
import type { OrganizationWriteOutcome } from "@/lib/organization-write-receipt";
import {
  type RecordWriteInTransaction,
  writeRecorded,
} from "@/lib/record-write-in-transaction";
import { refreshExistingPublicRepositoryAuthority } from "./authority-persistence";

type GitHubRepoApiResponse = {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  html_url: string;
  private: boolean;
  default_branch?: unknown;
};

// Regex patterns for GitHub URL parsing
const PROTOCOL_PATTERN = /^https?:\/\//i;
const WWW_PREFIX_PATTERN = /^www\./i;
const GIT_SUFFIX_PATTERN = /\.git$/i;
const TRAILING_SLASH_PATTERN = /\/+$/;
const EMBEDDED_BRANCH_DATA_PATTERN =
  /<script type="application\/json" data-target="react-app\.embeddedData">(?<data>.*?)<\/script>/s;
const GITHUB_REST_API_VERSION = "2026-03-10";
const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
} as const;
const GITHUB_BRANCHES_PAGE_HEADERS = {
  Accept: "text/html,application/xhtml+xml",
} as const;
/**
 * Hard ceiling on the branch pages scraped per request. A page whose branch
 * names were all seen already does not grow the collected list, so `has_more`
 * alone can keep the loop going without ever reaching `limit`. The route caps
 * `limit` at 100 and a page carries 20 branches, so 10 pages leaves headroom
 * over the widest legitimate request.
 */
export const PUBLIC_BRANCHES_MAX_PAGES = 10;

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
  const response = await boundedFetch(
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
): Promise<GetBranchesResponse> {
  const branches: GetBranchesResponse["branches"] = [];
  const seenBranchNames = new Set<string>();
  let page = 1;
  // `null` until a page has actually been read, so a request that never scrapes
  // cannot report a more-pages signal this function never observed.
  let upstreamHasMore: boolean | null = null;
  let defaultBranchName: string | null = null;

  while (
    branches.length < limit &&
    upstreamHasMore !== false &&
    page <= PUBLIC_BRANCHES_MAX_PAGES
  ) {
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

    upstreamHasMore = branchPage.payload.has_more;
    page += 1;
  }

  const hasMore = upstreamHasMore === true;
  // The scrape gave up on its own ceiling while GitHub still had pages, so the
  // caller's `limit` was never satisfied and this list is not the whole set.
  const truncated = hasMore && branches.length < limit;

  if (truncated) {
    log.warn("[public-repositories] Branch page scrape hit the page cap", {
      owner,
      name,
      limit,
      collected: branches.length,
      maxPages: PUBLIC_BRANCHES_MAX_PAGES,
    });
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

  // Absent rather than `false` when nothing was truncated: a client on an older
  // bundle reads the omission as today's unmarked success.
  return {
    branches: branches.slice(0, limit),
    ...(hasMore ? { hasMore } : {}),
    ...(truncated ? { truncated } : {}),
  };
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
  const identity = parseRepositoryFullName(normalized);
  return identity ? { owner: identity.owner, name: identity.repo } : null;
}

export const publicRepositoryService = {
  /**
   * Add a public GitHub repository to the organization.
   *
   * Validates the URL, confirms the repo is public and accessible on GitHub,
   * then creates a PublicRepository record. The reachability read runs through
   * the requesting user's resolver credential when one exists (PLN-1525 step 4
   * — Vercel's shared egress IP pools the 60 req/hr unauthenticated budget
   * with every other tenant); users without a usable connection keep the
   * unauthenticated path. Either way a repo reported `private` is rejected —
   * an authenticated read can see private repos, and recording one as public
   * would lie.
   *
   * Returns:
   * - `Result.err(Status.BadRequest)` if the URL is not parseable
   * - `Result.err(AddPublicRepositoryErrorCode.RepositoryNotPublic)` if the
   *   repo resolves but is private — a valid URL, so the route must not report
   *   it as an invalid one
   * - `Result.err(Status.NotFound)` if GitHub returns 404
   * - `Result.ok(repo)` on success
   */
  async addPublicRepository(
    organizationId: string,
    userId: string,
    url: string,
    recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
  ): Promise<
    Result<PublicRepository, StatusCode | AddPublicRepositoryErrorCode>
  > {
    const parsed = parseGitHubRepoUrl(url);
    if (!parsed) {
      log.warn("[public-repositories] Failed to parse GitHub repo URL", {
        url,
      });
      return Result.err(Status.BadRequest);
    }

    const { owner, name } = parsed;
    const acquisition = {
      observationKey: `repository_rest:${uuidv7()}`,
      observedAt: new Date(),
    };

    const lookup = await lookupGitHubRepository(
      organizationId,
      userId,
      owner,
      name
    );
    if (lookup.status === PublicRepoLookupStatus.NotFound) {
      log.warn("[public-repositories] GitHub repo not found or not public", {
        owner,
        name,
      });
      return Result.err(Status.NotFound);
    }
    if (lookup.status === PublicRepoLookupStatus.NotPublic) {
      log.warn("[public-repositories] Repository is private, refusing", {
        owner,
        name,
      });
      return Result.err(AddPublicRepositoryErrorCode.RepositoryNotPublic);
    }
    if (lookup.status !== PublicRepoLookupStatus.Found) {
      log.error("[public-repositories] GitHub API error", { owner, name });
      return Result.err(Status.Error);
    }
    const repoData = lookup.repo;
    const defaultAuthority = mapGitHubRepositoryDefaultAuthority({
      providerRepositoryId: String(repoData.id),
      fullName: repoData.full_name,
      defaultBranch: repoData.default_branch,
      source: RepositoryDefaultSource.RepositoryRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: lookup.credentialType,
      ...(lookup.credentialOwnerId
        ? { credentialOwnerId: lookup.credentialOwnerId }
        : {}),
      observationKey: acquisition.observationKey,
      observedAt: acquisition.observedAt,
    });

    try {
      const repo = await writeRecorded(
        recordWrite,
        () =>
          withDb((db) =>
            db.publicRepository.create({
              data: {
                organizationId,
                githubRepoId: String(repoData.id),
                fullName: repoData.full_name,
                owner: repoData.owner.login,
                name: repoData.name,
                htmlUrl: repoData.html_url,
                ...repositoryDefaultAuthorityPersistenceData(defaultAuthority),
              },
            })
          ),
        () => ({ changed: true })
      );

      log.info("[public-repositories] Added public repository", {
        organizationId,
        fullName: repoData.full_name,
      });

      return Result.ok(repo);
    } catch (error: unknown) {
      if (getPrismaErrorCode(error) === "P2002") {
        await refreshExistingPublicRepositoryAuthority(
          organizationId,
          String(repoData.id),
          defaultAuthority
        );
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
    id: string,
    recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
  ): Promise<void> {
    await writeRecorded(
      recordWrite,
      () =>
        withDb((db) =>
          db.publicRepository.deleteMany({ where: { id, organizationId } })
        ),
      ({ count }) => ({ changed: count > 0 })
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
        // Only the coordinates the GitHub call and its failure log need — the
        // twelve `defaultBranch*` authority-snapshot columns are unread here.
        select: { owner: true, name: true, fullName: true },
      })
    );

    if (!repository) {
      throw new Error("Repository not found");
    }

    try {
      return await getPublicRepositoryBranches(
        repository.owner,
        repository.name,
        limit
      );
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

const PublicRepoLookupStatus = {
  Found: "found",
  NotFound: "not_found",
  NotPublic: "not_public",
  Error: "error",
} as const;
type PublicRepoLookupStatus =
  (typeof PublicRepoLookupStatus)[keyof typeof PublicRepoLookupStatus];

type PublicRepoLookup =
  | {
      status: typeof PublicRepoLookupStatus.Found;
      repo: GitHubRepoApiResponse;
      credentialType: GitHubFetchCredentialType;
      credentialOwnerId?: string;
    }
  | {
      status: Exclude<
        PublicRepoLookupStatus,
        typeof PublicRepoLookupStatus.Found
      >;
    };

/**
 * Read the repository through the requesting user's resolver credential when
 * one resolves; any resolver denial falls back to the unauthenticated read so
 * unconnected users keep today's behavior. GitHub cloaks no-access private
 * repos as 404 on both paths, so "not found" and "not public but invisible"
 * intentionally collapse into NotFound.
 */
async function lookupGitHubRepository(
  organizationId: string,
  userId: string,
  owner: string,
  name: string
): Promise<PublicRepoLookup> {
  const resolved = await getGitHubClient({
    organizationId,
    userId,
    target: { owner, repo: name },
    intent: GitHubAccessIntent.ReadAsUser,
  });
  if (!resolved.ok) {
    // PLN-1742 M6: name the denial before falling back — this branch now
    // absorbs Clerk-lane denials too, and a silent collapse would make a
    // credential regression look like ordinary unconnected-user traffic.
    log.info("[public-repositories] Resolver denied; reading unauthenticated", {
      owner,
      name,
      reason: resolved.error.reason,
    });
    return await lookupGitHubRepositoryUnauthenticated(owner, name);
  }
  try {
    const { data } = await resolved.value.octokit.rest.repos.get({
      owner,
      repo: name,
      headers: { "X-GitHub-Api-Version": GITHUB_REST_API_VERSION },
    });
    if (data.private) {
      return { status: PublicRepoLookupStatus.NotPublic };
    }
    return {
      status: PublicRepoLookupStatus.Found,
      credentialType:
        resolved.value.kind === GitHubCredentialKind.OauthUser
          ? GitHubFetchCredentialType.UserOAuth
          : GitHubFetchCredentialType.GitHubApp,
      ...(resolved.value.kind === GitHubCredentialKind.OauthUser
        ? { credentialOwnerId: userId }
        : {}),
      repo: {
        id: data.id,
        full_name: data.full_name,
        name: data.name,
        owner: { login: data.owner.login },
        html_url: data.html_url,
        private: data.private,
        default_branch: data.default_branch,
      },
    };
  } catch (error) {
    if (extractGitHubHttpStatus(error) === 404) {
      return { status: PublicRepoLookupStatus.NotFound };
    }
    log.error("[public-repositories] Authenticated repo lookup failed", {
      owner,
      name,
      status: extractGitHubHttpStatus(error),
    });
    return { status: PublicRepoLookupStatus.Error };
  }
}

async function lookupGitHubRepositoryUnauthenticated(
  owner: string,
  name: string
): Promise<PublicRepoLookup> {
  let repo: GitHubRepoApiResponse;
  try {
    const response = await boundedFetch(
      `https://api.github.com/repos/${owner}/${name}`,
      {
        headers: GITHUB_API_HEADERS,
      }
    );
    if (!response.ok) {
      if (response.status === 404) {
        return { status: PublicRepoLookupStatus.NotFound };
      }
      log.error("[public-repositories] GitHub API error", {
        owner,
        name,
        status: response.status,
      });
      return { status: PublicRepoLookupStatus.Error };
    }
    // `fetch` resolves once the headers land, so consuming the body is its own
    // failure domain: a stalled stream or unparseable JSON has to reach the same
    // Error result as a failed round trip rather than reject out of the lookup.
    repo = (await response.json()) as GitHubRepoApiResponse;
  } catch (error) {
    // A timed-out or otherwise failed read must stay inside the lookup's result
    // contract, as the authenticated branch above already does —
    // `addPublicRepository` reports errors as values, not throws.
    log.error("[public-repositories] Unauthenticated repo lookup failed", {
      owner,
      name,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return { status: PublicRepoLookupStatus.Error };
  }
  if (repo.private) {
    return { status: PublicRepoLookupStatus.NotPublic };
  }
  return {
    status: PublicRepoLookupStatus.Found,
    repo,
    credentialType: GitHubFetchCredentialType.Unauthenticated,
  };
}

/**
 * Failure codes `addPublicRepository` reports alongside `StatusCode`, for
 * outcomes whose HTTP status alone cannot tell the route what to say.
 */
export const AddPublicRepositoryErrorCode = {
  RepositoryNotPublic: "repository_not_public",
} as const;
export type AddPublicRepositoryErrorCode =
  (typeof AddPublicRepositoryErrorCode)[keyof typeof AddPublicRepositoryErrorCode];

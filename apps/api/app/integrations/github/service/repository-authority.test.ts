import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import type { RepositoryDefaultAuthority } from "@repo/api/src/types/repository-default-identity";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { GitHubProviderResultStatus } from "@repo/github";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acquireInstallationClient } from "@/lib/github/installation-client";
import { fetchInstallationRepositories } from "./installation-repositories-fetch";
import { bulkUpsertInstallationRepositories } from "./repository-sync";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("uuid", () => ({ v7: vi.fn(() => "attempt-1") }));

vi.mock("@/lib/github/installation-client", () => ({
  acquireInstallationClient: vi.fn(),
}));

const mockAcquireInstallationClient = vi.mocked(acquireInstallationClient);
const mockLogError = vi.mocked(log.error);

describe("repository default authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the scoped REST version and one acquisition identity across pages", async () => {
    const listReposAccessibleToInstallation = vi
      .fn()
      .mockResolvedValueOnce({
        data: { repositories: makeRepositoryPage(100), total_count: 101 },
      })
      .mockResolvedValueOnce({
        data: { repositories: makeRepositoryPage(1, 101), total_count: 101 },
      });
    mockAcquireInstallationClient.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        rest: { apps: { listReposAccessibleToInstallation } },
      },
    } as never);

    const result = await fetchInstallationRepositories(100);

    expect(result.ok).toBe(true);
    expect(listReposAccessibleToInstallation).toHaveBeenNthCalledWith(1, {
      per_page: 100,
      page: 1,
      headers: { "X-GitHub-Api-Version": "2026-03-10" },
    });
    expect(listReposAccessibleToInstallation).toHaveBeenNthCalledWith(2, {
      per_page: 100,
      page: 2,
      headers: { "X-GitHub-Api-Version": "2026-03-10" },
    });
    if (!result.ok) {
      throw new Error("Expected a complete installation repository result");
    }
    expect(
      new Set(
        result.repositories.map(
          (repository) => repository.defaultAuthority?.provenance.observationKey
        )
      )
    ).toEqual(new Set(["installation_repositories_rest:attempt-1"]));
  });

  it("classifies a provider rate limit at the production fetch boundary", async () => {
    mockAcquireInstallationClient.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 60,
    });

    const result = await fetchInstallationRepositories(100);

    expect(result).toMatchObject({
      ok: false,
      unavailable: { reason: RepositoryDefaultReason.RateLimited },
    });
  });

  it("preserves rate-limit classification from a failed repository page", async () => {
    const listReposAccessibleToInstallation = vi.fn().mockRejectedValue({
      status: 429,
      response: { headers: { "retry-after": "60" } },
    });
    mockAcquireInstallationClient.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        rest: { apps: { listReposAccessibleToInstallation } },
      },
    } as never);

    const result = await fetchInstallationRepositories(100);

    expect(result).toMatchObject({
      ok: false,
      unavailable: { reason: RepositoryDefaultReason.RateLimited },
    });
  });

  it("preserves permission-filtered classification from a failed repository page", async () => {
    const listReposAccessibleToInstallation = vi
      .fn()
      .mockRejectedValue({ status: 403 });
    mockAcquireInstallationClient.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        rest: { apps: { listReposAccessibleToInstallation } },
      },
    } as never);

    const result = await fetchInstallationRepositories(100);

    expect(result).toMatchObject({
      ok: false,
      unavailable: { reason: RepositoryDefaultReason.PermissionFiltered },
    });
  });

  it("classifies the bounded page ceiling as a partial capped observation", async () => {
    const listReposAccessibleToInstallation = vi.fn().mockResolvedValue({
      data: { repositories: makeRepositoryPage(100), total_count: 2100 },
    });
    mockAcquireInstallationClient.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        rest: { apps: { listReposAccessibleToInstallation } },
      },
    } as never);

    const result = await fetchInstallationRepositories(100);

    expect(result).toMatchObject({
      ok: false,
      unavailable: { reason: RepositoryDefaultReason.Capped },
    });
    expect(listReposAccessibleToInstallation).toHaveBeenCalledTimes(20);
  });

  it("emits monitored stale-rejection and equal-time conflict events", async () => {
    const authority = buildRepositoryAuthority(
      "attempt-1",
      "2026-08-10T10:00:00.000Z"
    );
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([
          {
            githubRepoId: "repo-1",
            defaultBranchObservedAt: new Date("2026-08-10T11:00:00.000Z"),
            defaultBranchReason: null,
          },
        ])
        .mockResolvedValueOnce([
          {
            githubRepoId: "repo-1",
            defaultBranchObservedAt: new Date("2026-08-10T10:00:00.000Z"),
            defaultBranchReason: RepositoryDefaultReason.Conflicting,
          },
        ]),
    };
    const repository = {
      githubRepoId: "repo-1",
      fullName: "acme/repo-1",
      name: "repo-1",
      owner: "acme",
      private: false,
      defaultAuthority: authority,
    };

    await bulkUpsertInstallationRepositories(
      tx as never,
      "00000000-0000-0000-0000-000000000001",
      [repository]
    );
    await bulkUpsertInstallationRepositories(
      tx as never,
      "00000000-0000-0000-0000-000000000001",
      [repository]
    );

    expect(mockLogError).toHaveBeenCalledWith(
      "github_repository_default_authority_stale_rejected",
      expect.objectContaining({ githubRepoId: "repo-1" })
    );
    expect(mockLogError).toHaveBeenCalledWith(
      "github_repository_default_authority_conflict",
      expect.objectContaining({ githubRepoId: "repo-1" })
    );
  });
});

function makeRepositoryPage(count: number, start = 1) {
  return Array.from({ length: count }, (_, index) => {
    const id = start + index;
    return {
      id,
      name: `repo-${id}`,
      full_name: `acme/repo-${id}`,
      owner: { login: "acme" },
      private: false,
      default_branch: "main",
    };
  });
}

function buildRepositoryAuthority(
  observationKey: string,
  observedAt: string
): RepositoryDefaultAuthority {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: "repo-1",
      fullName: "acme/repo-1",
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch: "main",
    },
    provenance: {
      source: RepositoryDefaultSource.InstallationRepositoriesRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey,
      observedAt,
    },
  };
}

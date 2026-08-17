import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  GitHubPRState,
  GitHubRepositorySource,
} from "@repo/api/src/types/github.ts";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model.ts";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity.ts";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind.ts";

export type FakeGitHubAuthorityServer = {
  env: Record<string, string>;
  requests: readonly string[];
  close: () => Promise<void>;
};

/** Optional bounded-response controls for launched Desktop authority scenarios. */
export type FakeGitHubAuthorityServerOptions = {
  /** Branches returned by each repository's bounded Branches request. */
  branchNamesByRepository?: Readonly<Record<string, readonly string[]>>;
  /**
   * Pull-request heads returned by a response that explicitly reports more
   * pages. The server deliberately does not implement pagination: callers must
   * preserve repository authority and treat the omitted PRs as enrichment-only.
   */
  cappedPullRequestBranchesByRepository?: Readonly<
    Record<string, readonly string[]>
  >;
  /** Returned PR heads whose exact fork repository/default is unavailable. */
  unavailablePullRequestHeadBranchesByRepository?: Readonly<
    Record<string, readonly string[]>
  >;
};

/**
 * Serve repository-default authority through Desktop's real cloud hydration
 * boundary, with empty overlays by default and bounded fixtures on request.
 */
export async function startFakeGitHubAuthorityServer(
  repoFullNames: readonly string[],
  options: FakeGitHubAuthorityServerOptions = {}
): Promise<FakeGitHubAuthorityServer> {
  const repositories = [...new Set(repoFullNames)]
    .sort()
    .map(repositoryFixture);
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "/");
    routeRequest(request, response, repositories, options);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake GitHub authority server did not bind to a TCP port");
  }
  return {
    env: {
      CLOSEDLOOP_API_KEY: "sk_live_desktop_e2e_authority",
      CL_AUTH_API_ORIGIN: `http://127.0.0.1:${address.port}`,
    },
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Exact available/complete authority group for existing HTTP fixture servers. */
export function completeFakeGitHubAuthority(
  fullName: string,
  providerRepositoryId: string,
  source: RepositoryDefaultSource = RepositoryDefaultSource.InstallationRepositoriesRest
) {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId,
      fullName,
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch: "main",
    },
    provenance: {
      source,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.SurfaceOpen,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: `desktop-e2e:${fullName}`,
      observedAt: "2026-08-11T12:00:00.000Z",
    },
  };
}

type RepositoryFixture = ReturnType<typeof repositoryFixture>;

function repositoryFixture(fullName: string, index: number) {
  const providerRepositoryId = `desktop-e2e-repository-${index}`;
  return {
    id: providerRepositoryId,
    fullName,
    githubRepoId: providerRepositoryId,
    source: GitHubRepositorySource.Installation,
    repositoryDefaultAuthority: completeFakeGitHubAuthority(
      fullName,
      providerRepositoryId
    ),
  };
}

function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  repositories: readonly RepositoryFixture[],
  options: FakeGitHubAuthorityServerOptions
): void {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (
    request.method === "GET" &&
    pathname === "/integrations/github/repositories"
  ) {
    writeJson(response, repositories);
    return;
  }
  const repository = repositories.find((candidate) =>
    pathname.startsWith(`/integrations/github/repositories/${candidate.id}/`)
  );
  if (
    request.method === "GET" &&
    repository &&
    pathname.endsWith("/branches")
  ) {
    writeJson(response, {
      branches: (
        options.branchNamesByRepository?.[repository.fullName] ?? []
      ).map(branchFixture),
    });
    return;
  }
  if (
    request.method === "GET" &&
    repository &&
    pathname.endsWith("/pull-requests")
  ) {
    const cappedBranches =
      options.cappedPullRequestBranchesByRepository?.[repository.fullName];
    const unavailableHeadBranches =
      options.unavailablePullRequestHeadBranchesByRepository?.[
        repository.fullName
      ] ?? [];
    const pullRequestBranches = [
      ...new Set([...(cappedBranches ?? []), ...unavailableHeadBranches]),
    ];
    writeJson(
      response,
      cappedBranches === undefined && unavailableHeadBranches.length === 0
        ? { pullRequests: [] }
        : {
            ...(cappedBranches === undefined ? {} : { hasMore: true }),
            pullRequests: pullRequestBranches.map((branchName, index) =>
              pullRequestFixture(
                repository,
                branchName,
                index,
                unavailableHeadBranches.includes(branchName)
              )
            ),
          }
    );
    return;
  }
  response.statusCode = 404;
  writeJson(response, { error: "not found" });
}

function branchFixture(name: string) {
  return {
    committedDate: "2026-08-11T12:00:00.000Z",
    isDefault: name === "main",
    name,
  };
}

function pullRequestFixture(
  repository: RepositoryFixture,
  headBranch: string,
  index: number,
  headRepositoryUnavailable: boolean
) {
  const number = 101 + index;
  const headRepository = completeFakeGitHubAuthority(
    repository.fullName,
    repository.githubRepoId,
    RepositoryDefaultSource.PullRequestRest
  );
  return {
    author: "desktop-e2e",
    baseBranch: "main",
    headBranch,
    ...(headRepositoryUnavailable
      ? {
          headRepositoryUnavailable: {
            reason: RepositoryDefaultReason.NotReported,
            provenance: headRepository.provenance,
          },
        }
      : { headRepository }),
    htmlUrl: `https://github.com/${repository.fullName}/pull/${number}`,
    number,
    state: GitHubPRState.Open,
    title: `Desktop E2E PR ${number}`,
    updatedAt: "2026-08-11T12:00:00.000Z",
  };
}

function writeJson(response: ServerResponse, body: unknown): void {
  response.statusCode = response.statusCode || 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

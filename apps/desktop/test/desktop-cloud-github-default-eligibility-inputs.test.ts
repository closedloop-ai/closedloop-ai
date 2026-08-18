import assert from "node:assert/strict";
import { test } from "node:test";
import { BranchCloudHydrationStatus } from "@repo/api/src/types/branch";
import {
  GitHubPRState,
  GitHubRepositorySource,
} from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  type RepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import {
  isEligibleBranchKey,
  resolveBranchDefaultEligibilitySnapshot,
} from "../src/main/branch/shared-branches-default-eligibility.js";
import {
  DesktopCloudGitHubHydration,
  type RepositoryDefaultAuthorityReadName,
} from "../src/main/cloud/desktop-cloud-github-hydration.js";

test("eligibility inputs await authority persistence and retain fork-head identity", async () => {
  const baseAuthority = authority("base/repository", "base-1", "trunk");
  const forkAuthority = authority("fork-owner/repository", "fork-1", "main");
  let releaseAuthorityWrite: () => void = () => undefined;
  let authorityWriteStarted = false;
  let authorityWriteFinished = false;
  const authorityWriteRelease = new Promise<void>((resolve) => {
    releaseAuthorityWrite = resolve;
  });
  const readAuthorityCalls: (readonly RepositoryDefaultAuthorityReadName[])[] =
    [];
  const readAuthorities = (
    _identityKey: string,
    repositories: readonly RepositoryDefaultAuthorityReadName[]
  ) => {
    readAuthorityCalls.push(repositories);
    assert.equal(authorityWriteFinished, true);
    return Promise.resolve([baseAuthority, forkAuthority]);
  };
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    fetch: (url) =>
      Promise.resolve(
        Response.json(
          responseForUrl(url.toString(), baseAuthority, forkAuthority)
        )
      ),
    store: {
      readOverlays: () => Promise.resolve({}),
      writeOverlays: () => Promise.resolve(),
      writeRepositoryDefaultAuthorities: async () => {
        authorityWriteStarted = true;
        await authorityWriteRelease;
        authorityWriteFinished = true;
      },
      readRepositoryDefaultAuthoritiesByNames: readAuthorities,
    },
  });

  const resultPromise = hydration.resolveRepositoryDefaultEligibilityInputs({
    rows: [{ repoFullName: "base/repository", branchName: "feature/fork" }],
    scope: "detail",
  });
  let settled = false;
  const observedResult = resultPromise.finally(() => {
    settled = true;
  });
  await waitFor(() => authorityWriteStarted);
  assert.equal(authorityWriteStarted, true);
  assert.equal(settled, false);
  releaseAuthorityWrite();

  const result = await observedResult;
  const overlay = result.overlays?.["base/repository::feature/fork"];
  assert.equal(result.status, BranchCloudHydrationStatus.Fresh);
  assert.equal(
    result.rowHydrationResult?.status,
    BranchCloudHydrationStatus.Fresh
  );
  const snapshot = await resolveBranchDefaultEligibilitySnapshot(
    [{ repoFullName: "base/repository", branchName: "feature/fork" }],
    {
      resolveRepositoryDefaultEligibilityInputs: () => Promise.resolve(result),
    },
    { scope: "detail" }
  );
  assert.equal(snapshot?.resolvedHydration, result.rowHydrationResult);
  assert.equal(overlay?.headRepositoryProvider, VcsProviderKind.GitHub);
  assert.equal(overlay?.headRepositoryProviderId, "fork-1");
  assert.equal(overlay?.headRepositoryFullName, "fork-owner/repository");
  assert.deepEqual(readAuthorityCalls[0], [
    { provider: VcsProviderKind.GitHub, fullName: "base/repository" },
    { provider: VcsProviderKind.GitHub, fullName: "fork-owner/repository" },
  ]);
  assert.equal(readAuthorityCalls.length, 1);
});

test("eligibility inputs fail closed when current authority persistence fails", async () => {
  const baseAuthority = authority("base/repository", "base-1", "trunk");
  let authorityReadCount = 0;
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    fetch: (url) =>
      Promise.resolve(
        Response.json(responseForUrl(url.toString(), baseAuthority))
      ),
    store: {
      readOverlays: () => Promise.resolve({}),
      writeOverlays: () => Promise.resolve(),
      writeRepositoryDefaultAuthorities: () =>
        Promise.reject(new Error("authority write unavailable")),
      readRepositoryDefaultAuthoritiesByNames: () => {
        authorityReadCount += 1;
        return Promise.resolve([baseAuthority]);
      },
    },
  });

  const request = {
    rows: [{ repoFullName: "base/repository", branchName: "feature/fork" }],
    scope: "detail" as const,
  };
  const first =
    await hydration.resolveRepositoryDefaultEligibilityInputs(request);
  const cached =
    await hydration.resolveRepositoryDefaultEligibilityInputs(request);

  assert.equal(first.status, BranchCloudHydrationStatus.Failed);
  assert.equal(first.failure, "repository_default_authority_write_failed");
  assert.equal(first.rowHydrationResult, undefined);
  assert.deepEqual(first.authorities, []);
  assert.equal(cached.status, BranchCloudHydrationStatus.Failed);
  assert.deepEqual(cached.authorities, []);
  assert.equal(authorityReadCount, 0);
});

test("eligibility inputs preserve an exact unavailable reason without a base identity fallback", async () => {
  const baseAuthority = authority("base/repository", "base-1", "main");
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    fetch: (url) =>
      Promise.resolve(
        Response.json(
          responseForUrl(url.toString(), baseAuthority, undefined, {
            reason: RepositoryDefaultReason.PermissionFiltered,
            provenance: provenance(
              RepositoryDefaultSource.PullRequestRest,
              "fork-unavailable"
            ),
          })
        )
      ),
    store: {
      readOverlays: () => Promise.resolve({}),
      writeOverlays: () => Promise.resolve(),
      writeRepositoryDefaultAuthorities: () => Promise.resolve(),
      readRepositoryDefaultAuthoritiesByNames: () =>
        Promise.resolve([baseAuthority]),
    },
  });

  const result = await hydration.resolveRepositoryDefaultEligibilityInputs({
    rows: [{ repoFullName: "base/repository", branchName: "feature/fork" }],
    scope: "detail",
  });
  const overlay = result.overlays?.["base/repository::feature/fork"];

  assert.equal(
    overlay?.headRepositoryUnavailableReason,
    RepositoryDefaultReason.PermissionFiltered
  );
  assert.equal(overlay?.headRepositoryProviderId, undefined);
  assert.equal(overlay?.headRepositoryFullName, undefined);
});

test("a PR ProviderError cannot blank a base candidate with current complete default authority", async () => {
  const baseAuthority = authority("base/repository", "base-1", "main");
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    fetch: (url) => {
      const href = url.toString();
      if (href.endsWith("/repositories")) {
        return Promise.resolve(
          Response.json({
            success: true,
            data: [
              {
                id: "base-1",
                fullName: "base/repository",
                githubRepoId: "base-1",
                source: GitHubRepositorySource.Installation,
                repositoryDefaultAuthority: baseAuthority,
              },
            ],
          })
        );
      }
      if (href.includes("/pull-requests")) {
        return Promise.reject(new Error("pull requests unavailable"));
      }
      return Promise.resolve(
        Response.json({
          success: true,
          data: {
            branches: [
              {
                name: "feature/base",
                committedDate: "2026-08-11T10:00:00.000Z",
              },
            ],
          },
        })
      );
    },
    store: {
      readOverlays: () => Promise.resolve({}),
      writeOverlays: () => Promise.resolve(),
      writeRepositoryDefaultAuthorities: () => Promise.resolve(),
      readRepositoryDefaultAuthoritiesByNames: () =>
        Promise.resolve([baseAuthority]),
    },
  });
  const row = {
    repoFullName: "base/repository",
    branchName: "feature/base",
  };
  const inputs = await hydration.resolveRepositoryDefaultEligibilityInputs({
    rows: [row],
    scope: "list",
  });
  const snapshot = await resolveBranchDefaultEligibilitySnapshot(
    [row],
    {
      resolveRepositoryDefaultEligibilityInputs: () => Promise.resolve(inputs),
    },
    { scope: "list" }
  );

  assert.equal(inputs.status, BranchCloudHydrationStatus.Failed);
  assert.equal(inputs.eligibilityStatus, BranchCloudHydrationStatus.Fresh);
  assert.equal(inputs.rowHydrationResult, undefined);
  assert.equal(inputs.failure, "cloud_pull_failed");
  assert.equal(
    inputs.pullRequestIncompleteReasons?.["base/repository"],
    RepositoryDefaultReason.ProviderError
  );
  assert.equal(
    inputs.overlays?.["base/repository::feature/base"]
      ?.headRepositoryUnavailableReason,
    undefined
  );
  assert.equal(isEligibleBranchKey(row, snapshot), true);
  assert.equal(snapshot?.coverageComplete, true);
  assert.equal(snapshot?.resolvedHydration, undefined);
});

test("current repository authority preserves a persisted fork omitted by capped PR coverage", async () => {
  const baseAuthority = authority("base/repository", "base-1", "main");
  const forkAuthority = authority(
    "persisted-fork/repository",
    "persisted-fork-1",
    "main"
  );
  const repositoryReads: string[][] = [];
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    fetch: (url) =>
      Promise.resolve(
        Response.json(
          responseForUrl(
            url.toString(),
            baseAuthority,
            forkAuthority,
            undefined,
            true
          )
        )
      ),
    store: {
      readOverlays: () =>
        Promise.resolve({
          "base/repository::feature/fork": {
            prNumber: 5828,
            headRepositoryProvider: VcsProviderKind.GitHub,
            headRepositoryProviderId: "persisted-fork-1",
            headRepositoryFullName: "persisted-fork/repository",
          },
        }),
      writeOverlays: () => Promise.resolve(),
      writeRepositoryDefaultAuthorities: () => Promise.resolve(),
      readRepositoryDefaultAuthoritiesByNames: (_identityKey, repositories) => {
        repositoryReads.push(
          repositories.map((repository) => repository.fullName)
        );
        return Promise.resolve([baseAuthority]);
      },
    },
  });

  const result = await hydration.resolveRepositoryDefaultEligibilityInputs({
    rows: [{ repoFullName: "base/repository", branchName: "feature/fork" }],
    scope: "detail",
  });

  assert.equal(
    result.overlays?.["base/repository::feature/fork"]
      ?.headRepositoryProviderId,
    "persisted-fork-1"
  );
  assert.deepEqual(repositoryReads, [
    ["base/repository", "persisted-fork/repository"],
  ]);
  assert.equal(
    result.authorities.find(
      (item) => item.repository.fullName === "persisted-fork/repository"
    )?.evidence.availability,
    RepositoryDefaultAvailability.Available
  );
});

test("eligibility authority reads deterministically chunk more than 100 selected and fork repositories", async () => {
  const overlays = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `base/repository::feature/${index}`,
      {
        headRepositoryProvider: VcsProviderKind.GitHub,
        headRepositoryProviderId: `fork-${index}`,
        headRepositoryFullName: `fork-${index}/repository`,
      },
    ])
  );
  const chunks: string[][] = [];
  const hydration = new DesktopCloudGitHubHydration({
    getAccessToken: () => Promise.resolve(null),
    getSessionIdentity: () => ({
      userId: "user-1",
      organizationId: "org-1",
    }),
    getApiOrigin: () => "https://api.example.test",
    store: {
      readOverlays: () => Promise.resolve(overlays),
      writeOverlays: () => Promise.resolve(),
      readRepositoryDefaultAuthoritiesByNames: (_identityKey, repositories) => {
        chunks.push(repositories.map((repository) => repository.fullName));
        return Promise.resolve([]);
      },
    },
  });

  const result = await hydration.resolveRepositoryDefaultEligibilityInputs({
    rows: [{ repoFullName: "base/repository", branchName: "feature/0" }],
    scope: "list",
  });

  assert.equal(result.status, BranchCloudHydrationStatus.Stale);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [100, 1]
  );
  assert.equal(chunks.flat().length, 101);
  assert.equal(new Set(chunks.flat()).size, 101);
});

test("eligibility fails closed when any authority read chunk rejects", async () => {
  const overlays = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `base/repository::feature/${index}`,
      {
        headRepositoryProvider: VcsProviderKind.GitHub,
        headRepositoryProviderId: `fork-${index}`,
        headRepositoryFullName: `fork-${index}/repository`,
      },
    ])
  );
  let readCount = 0;
  const hydration = new DesktopCloudGitHubHydration({
    getAccessToken: () => Promise.resolve(null),
    getSessionIdentity: () => ({
      userId: "user-1",
      organizationId: "org-1",
    }),
    getApiOrigin: () => "https://api.example.test",
    store: {
      readOverlays: () => Promise.resolve(overlays),
      writeOverlays: () => Promise.resolve(),
      readRepositoryDefaultAuthoritiesByNames: () => {
        readCount += 1;
        return readCount === 1
          ? Promise.resolve([])
          : Promise.reject(new Error("authority read unavailable"));
      },
    },
  });

  const result = await hydration.resolveRepositoryDefaultEligibilityInputs({
    rows: [{ repoFullName: "base/repository", branchName: "feature/0" }],
    scope: "list",
  });

  assert.equal(result.status, BranchCloudHydrationStatus.Failed);
  assert.equal(result.failure, "repository_default_authority_read_failed");
  assert.deepEqual(result.authorities, []);
  assert.equal(readCount, 2);
});

function responseForUrl(
  url: string,
  baseAuthority: RepositoryDefaultAuthority,
  forkAuthority?: RepositoryDefaultAuthority,
  forkUnavailable?: unknown,
  omitPullRequests = false
): unknown {
  if (url.endsWith("/repositories")) {
    return {
      success: true,
      data: [
        {
          id: "base-1",
          fullName: "base/repository",
          githubRepoId: "base-1",
          source: GitHubRepositorySource.Installation,
          repositoryDefaultAuthority: baseAuthority,
        },
        ...(forkAuthority
          ? [
              {
                id: forkAuthority.repository.providerRepositoryId,
                fullName: forkAuthority.repository.fullName,
                githubRepoId: forkAuthority.repository.providerRepositoryId,
                source: GitHubRepositorySource.Installation,
                repositoryDefaultAuthority: forkAuthority,
              },
            ]
          : []),
      ],
    };
  }
  if (url.includes("/branches")) {
    return { success: true, data: { branches: [] } };
  }
  return {
    success: true,
    data: {
      pullRequests: omitPullRequests
        ? []
        : [
            {
              number: 5828,
              title: "Fork PR",
              htmlUrl: "https://github.com/base/repository/pull/5828",
              headBranch: "feature/fork",
              baseBranch: "trunk",
              state: GitHubPRState.Open,
              updatedAt: "2026-08-11T10:00:00.000Z",
              author: "octocat",
              ...(forkAuthority === undefined
                ? {}
                : { headRepository: forkAuthority }),
              ...(forkUnavailable === undefined
                ? {}
                : { headRepositoryUnavailable: forkUnavailable }),
            },
          ],
      ...(omitPullRequests ? { hasMore: true } : {}),
    },
  };
}

function authority(
  fullName: string,
  providerRepositoryId: string,
  defaultBranch: string
): RepositoryDefaultAuthority {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId,
      fullName,
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch,
    },
    provenance: provenance(
      RepositoryDefaultSource.RepositoryRest,
      providerRepositoryId
    ),
  };
}

function provenance(source: RepositoryDefaultSource, observationKey: string) {
  return {
    source,
    mechanism: GitHubFetchMechanism.Rest,
    trigger: GitHubFetchTrigger.SurfaceOpen,
    credentialType: GitHubFetchCredentialType.GitHubApp,
    observationKey,
    observedAt: "2026-08-11T10:00:00.000Z",
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (predicate()) {
      return;
    }
  }
  throw new Error("timed out waiting for the authority write to start");
}

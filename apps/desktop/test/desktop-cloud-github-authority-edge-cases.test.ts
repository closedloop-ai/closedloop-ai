import assert from "node:assert/strict";
import { mock, test } from "node:test";
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
  applyCurrentForkAuthorityFreshness,
  collectHydrationResponses,
  staleHydrationResult,
} from "../src/main/cloud/desktop-cloud-github-eligibility-authority.js";
import {
  type BranchCloudHydrationOverlay,
  DesktopCloudGitHubHydration,
} from "../src/main/cloud/desktop-cloud-github-hydration.js";

test("eligibility authority helpers omit evidence that was not observed", () => {
  const baseAuthority = authority("base/repository", "base-1");
  const repository = {
    id: "base-1",
    fullName: "base/repository",
    githubRepoId: "base-1",
    source: GitHubRepositorySource.Installation,
  };

  const collection = collectHydrationResponses(
    [],
    [
      {
        status: "fulfilled",
        value: { repository, branches: [], pullRequests: [] },
      },
    ]
  );
  assert.deepEqual(collection.responses, []);

  const freshAuthorities = applyCurrentForkAuthorityFreshness(
    [baseAuthority],
    undefined,
    [repository.fullName],
    new Set()
  );
  assert.equal(freshAuthorities[0], baseAuthority);

  const stale = staleHydrationResult(
    {},
    {
      status: BranchCloudHydrationStatus.Failed,
    }
  );
  assert.equal(stale.status, BranchCloudHydrationStatus.Stale);
  assert.deepEqual(stale.overlays, {});
  assert.equal(stale.failure, undefined);
  assert.equal(stale.repositoryDefaultAuthorityOverrides, undefined);
  assert.equal(stale.repositoryDefaultAuthorityUnavailableNames, undefined);
  assert.equal(stale.pullRequestIncompleteReasons, undefined);
});

test("stale hydration keeps current failure evidence instead of retained authority", () => {
  const currentAuthority = authority("base/repository", "base-1");
  const stale = staleHydrationResult(
    {
      repositoryDefaultAuthorityOverrides: [
        authority("retained/repository", "retained-1"),
      ],
      repositoryDefaultAuthorityUnavailableNames: ["retained/repository"],
      pullRequestIncompleteReasons: {
        "retained/repository": RepositoryDefaultReason.Capped,
      },
    },
    {
      status: BranchCloudHydrationStatus.Failed,
      failure: "cloud_pull_failed",
      repositoryDefaultAuthorityOverrides: [currentAuthority],
      repositoryDefaultAuthorityUnavailableNames: ["current/repository"],
      pullRequestIncompleteReasons: {
        "current/repository": RepositoryDefaultReason.ProviderError,
      },
    }
  );

  assert.equal(stale.status, BranchCloudHydrationStatus.Stale);
  assert.equal(stale.failure, "cloud_pull_failed");
  assert.deepEqual(stale.repositoryDefaultAuthorityOverrides, [
    currentAuthority,
  ]);
  assert.deepEqual(stale.repositoryDefaultAuthorityUnavailableNames, [
    "current/repository",
  ]);
  assert.deepEqual(stale.pullRequestIncompleteReasons, {
    "current/repository": RepositoryDefaultReason.ProviderError,
  });
});

test("a requested repository omitted by the current list overrides persisted authority", async () => {
  const persistedAuthority = authority("base/repository", "base-1");
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    fetch: () => Promise.resolve(Response.json({ success: true, data: [] })),
    store: {
      readOverlays: () => Promise.resolve({}),
      writeOverlays: () => Promise.resolve(),
      writeRepositoryDefaultAuthorities: () => Promise.resolve(),
      readRepositoryDefaultAuthoritiesByNames: () =>
        Promise.resolve([persistedAuthority]),
    },
  });

  const result = await resolve(hydration, "feature/fork");

  assert.equal(result.status, BranchCloudHydrationStatus.Fresh);
  assert.equal(
    result.authorities[0]?.evidence.availability,
    RepositoryDefaultAvailability.Unavailable
  );
  assert.equal(
    result.authorities[0]?.evidence.reason,
    RepositoryDefaultReason.PermissionFiltered
  );
});

test("present-invalid PR head replaces retained identity with Unknown", async () => {
  const hydration = hydrationForResponses(
    (url) => {
      if (url.includes("/pull-requests")) {
        return pullRequestResponse([
          {
            ...pullRequest(1, authority("fork/old", "fork-old")),
            headRepository: null,
          },
        ]);
      }
      return responseForNonPr(url, ["feature/fork"]);
    },
    {
      "base/repository::feature/fork": {
        prNumber: 1,
        headRepositoryProvider: VcsProviderKind.GitHub,
        headRepositoryProviderId: "fork-old",
        headRepositoryFullName: "fork/old",
      },
    }
  );

  const result = await resolve(hydration, "feature/fork");
  const overlay = result.overlays?.["base/repository::feature/fork"];
  assert.equal(
    overlay?.headRepositoryUnavailableReason,
    RepositoryDefaultReason.Unknown
  );
  assert.equal(overlay?.headRepositoryProviderId, undefined);
});

test("conflicting fork identities for one base branch are Ambiguous in either order", async () => {
  const first = pullRequest(1, authority("fork/one", "fork-1"));
  const second = pullRequest(2, authority("fork/two", "fork-2"));
  for (const pullRequests of [
    [first, second],
    [second, first],
  ]) {
    const hydration = hydrationForResponses((url) =>
      url.includes("/pull-requests")
        ? pullRequestResponse(pullRequests)
        : responseForNonPr(url, ["feature/fork"])
    );
    const result = await resolve(hydration, "feature/fork");
    const overlay = result.overlays?.["base/repository::feature/fork"];
    assert.equal(
      overlay?.headRepositoryUnavailableReason,
      RepositoryDefaultReason.Ambiguous
    );
    assert.equal(overlay?.headRepositoryProviderId, undefined);
  }
});

test("partial pulls retain fulfilled head evidence without inventing fork absence", async () => {
  const headAuthority = authority("fork/visible", "fork-visible");
  const branchFailure = hydrationForResponses((url) => {
    if (url.includes("/branches")) {
      throw new Error("branches unavailable");
    }
    if (url.includes("/pull-requests")) {
      return pullRequestResponse([pullRequest(1, headAuthority)]);
    }
    return responseForNonPr(url, []);
  });
  const retained = await resolve(branchFailure, "feature/fork");
  assert.equal(retained.status, BranchCloudHydrationStatus.Failed);
  assert.equal(
    retained.overlays?.["base/repository::feature/fork"]
      ?.headRepositoryProviderId,
    "fork-visible"
  );

  const prFailure = hydrationForResponses((url) => {
    if (url.includes("/pull-requests")) {
      throw new Error("pull requests unavailable");
    }
    return responseForNonPr(url, ["feature/fork"]);
  });
  const unavailable = await resolve(prFailure, "feature/fork");
  assert.equal(unavailable.status, BranchCloudHydrationStatus.Failed);
  assert.equal(
    unavailable.overlays?.["base/repository::feature/fork"]
      ?.headRepositoryUnavailableReason,
    undefined
  );
  assert.equal(
    unavailable.pullRequestIncompleteReasons?.["base/repository"],
    RepositoryDefaultReason.ProviderError
  );
});

test("cached capped PR metadata never excludes a current no-PR candidate", async () => {
  const pullRequests = Array.from({ length: 100 }, (_, index) =>
    pullRequest(
      index + 1,
      authority("base/repository", "base-1"),
      `pr-${index}`
    )
  );
  const fetchResponse = mock.fn((url: string) => {
    if (url.includes("/pull-requests")) {
      return pullRequestResponse(pullRequests);
    }
    return responseForNonPr(url, []);
  });
  const hydration = hydrationForResponses(fetchResponse);

  const first = await resolve(hydration, "first-local-branch");
  const second = await resolve(hydration, "second-local-branch");

  assert.equal(first.status, BranchCloudHydrationStatus.Fresh);
  assert.equal(second.status, BranchCloudHydrationStatus.Fresh);
  assert.equal(
    first.overlays?.["base/repository::first-local-branch"]
      ?.headRepositoryUnavailableReason,
    undefined
  );
  assert.equal(
    second.overlays?.["base/repository::second-local-branch"]
      ?.headRepositoryUnavailableReason,
    undefined
  );
  assert.equal(
    first.pullRequestIncompleteReasons?.["base/repository"],
    RepositoryDefaultReason.Capped
  );
  assert.equal(
    second.pullRequestIncompleteReasons?.["base/repository"],
    RepositoryDefaultReason.Capped
  );
  assert.equal(
    fetchResponse.mock.calls.length,
    3,
    "the second candidate reuses repository cache"
  );
});

test("current omitted or invalid base authority replaces persisted availability", async () => {
  for (const [repositoryAuthority, expectedReason] of [
    [undefined, RepositoryDefaultReason.NotReported],
    [null, RepositoryDefaultReason.Unknown],
    [
      authority("other/repository", "other-id"),
      RepositoryDefaultReason.Malformed,
    ],
  ] as const) {
    const persisted = authority("base/repository", "base-1");
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
                  ...(repositoryAuthority === undefined
                    ? {}
                    : { repositoryDefaultAuthority: repositoryAuthority }),
                },
              ],
            })
          );
        }
        return Promise.resolve(
          Response.json(
            href.includes("/pull-requests")
              ? pullRequestResponse([])
              : responseForNonPr(href, ["feature/base"])
          )
        );
      },
      store: {
        readOverlays: () => Promise.resolve({}),
        writeOverlays: () => Promise.resolve(),
        writeRepositoryDefaultAuthorities: () => Promise.resolve(),
        readRepositoryDefaultAuthoritiesByNames: () =>
          Promise.resolve([persisted]),
      },
    });

    const result = await resolve(hydration, "feature/base");
    assert.equal(result.status, BranchCloudHydrationStatus.Fresh);
    assert.equal(result.authorities.length, 1);
    assert.equal(
      result.authorities[0]?.evidence.availability,
      RepositoryDefaultAvailability.Unavailable
    );
    assert.equal(
      "reason" in (result.authorities[0]?.evidence ?? {})
        ? result.authorities[0]?.evidence.reason
        : undefined,
      expectedReason
    );
  }
});

for (const prCoverage of ["capped", "failed"] as const) {
  test(`${prCoverage} PR coverage writes retained fork identity for the subsequent eligibility read`, async () => {
    const key = "base/repository::feature/fork";
    const baseAuthority = authority("base/repository", "base-1");
    const forkAuthority = authority("fork/repository", "fork-1");
    let persisted: Record<string, BranchCloudHydrationOverlay> = {
      [key]: {
        prNumber: 42,
        headRepositoryProvider: VcsProviderKind.GitHub,
        headRepositoryProviderId: "fork-1",
        headRepositoryFullName: "fork/repository",
      },
    };
    const writeOverlays = mock.fn(
      (
        _identityKey: string,
        _repoNames: readonly string[],
        overlays: Record<string, BranchCloudHydrationOverlay>
      ) => {
        persisted = { ...persisted, ...overlays };
        return Promise.resolve();
      }
    );
    const hydration = new DesktopCloudGitHubHydration({
      getApiKey: () => "sk_live_test",
      getApiOrigin: () => "https://api.example.test",
      fetch: (url) => {
        const href = url.toString();
        if (href.includes("/pull-requests")) {
          return prCoverage === "failed"
            ? Promise.reject(new Error("pull requests unavailable"))
            : Promise.resolve(
                Response.json({
                  success: true,
                  data: { pullRequests: [], hasMore: true },
                })
              );
        }
        return Promise.resolve(
          Response.json(responseForNonPr(href, ["feature/fork"]))
        );
      },
      store: {
        readOverlays: () => Promise.resolve(persisted),
        writeOverlays,
        writeRepositoryDefaultAuthorities: () => Promise.resolve(),
        readRepositoryDefaultAuthoritiesByNames: () =>
          Promise.resolve([baseAuthority, forkAuthority]),
      },
    });
    const request = {
      rows: [{ repoFullName: "base/repository", branchName: "feature/fork" }],
      scope: "list" as const,
    };

    const first =
      await hydration.resolveRepositoryDefaultEligibilityInputs(request);
    await waitFor(() => writeOverlays.mock.calls.length > 0);
    const subsequent =
      await hydration.resolveRepositoryDefaultEligibilityInputs(request);

    for (const result of [first, subsequent]) {
      assert.equal(result.overlays?.[key]?.prNumber, 42);
      assert.equal(result.overlays?.[key]?.headRepositoryProviderId, "fork-1");
    }
    assert.equal(persisted[key]?.prNumber, 42);
    assert.equal(persisted[key]?.headRepositoryProviderId, "fork-1");
    assert.equal(
      writeOverlays.mock.calls[0]?.arguments[2]?.[key]?.prNumber,
      42
    );
    assert.equal(
      writeOverlays.mock.calls[0]?.arguments[2]?.[key]
        ?.headRepositoryProviderId,
      "fork-1"
    );
  });
}

function hydrationForResponses(
  response: (url: string) => unknown,
  persistedOverlays: Record<string, Record<string, unknown>> = {}
) {
  return new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    fetch: (url) => Promise.resolve(Response.json(response(url.toString()))),
    store: {
      readOverlays: () => Promise.resolve(persistedOverlays),
      writeOverlays: () => Promise.resolve(),
      writeRepositoryDefaultAuthorities: () => Promise.resolve(),
      readRepositoryDefaultAuthoritiesByNames: () => Promise.resolve([]),
    },
  });
}

function resolve(hydration: DesktopCloudGitHubHydration, branchName: string) {
  return hydration.resolveRepositoryDefaultEligibilityInputs({
    rows: [{ repoFullName: "base/repository", branchName }],
    scope: "detail",
  });
}

function responseForNonPr(url: string, branches: readonly string[]): unknown {
  if (url.endsWith("/repositories")) {
    return {
      success: true,
      data: [
        {
          id: "base-1",
          fullName: "base/repository",
          githubRepoId: "base-1",
          source: GitHubRepositorySource.Installation,
          repositoryDefaultAuthority: authority("base/repository", "base-1"),
        },
      ],
    };
  }
  return {
    success: true,
    data: {
      branches: branches.map((name) => ({
        name,
        committedDate: "2026-08-11T10:00:00.000Z",
      })),
    },
  };
}

function pullRequestResponse(pullRequests: unknown[]) {
  return { success: true, data: { pullRequests } };
}

function pullRequest(
  number: number,
  headRepository: RepositoryDefaultAuthority,
  headBranch = "feature/fork"
) {
  return {
    number,
    title: `PR ${number}`,
    htmlUrl: `https://github.com/base/repository/pull/${number}`,
    headBranch,
    baseBranch: "main",
    state: GitHubPRState.Open,
    updatedAt: `2026-08-11T10:00:${String(number % 60).padStart(2, "0")}.000Z`,
    author: "octocat",
    headRepository,
  };
}

function authority(
  fullName: string,
  providerRepositoryId: string
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
      defaultBranch: "main",
    },
    provenance: {
      source: RepositoryDefaultSource.RepositoryRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.SurfaceOpen,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: providerRepositoryId,
      observedAt: "2026-08-11T10:00:00.000Z",
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (predicate()) {
      return;
    }
  }
  throw new Error("timed out waiting for the overlay write");
}

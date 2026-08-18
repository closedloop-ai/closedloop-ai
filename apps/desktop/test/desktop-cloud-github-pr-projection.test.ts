import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
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
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import {
  type BranchCloudHydrationOverlay,
  DesktopCloudGitHubHydration,
} from "../src/main/cloud/desktop-cloud-github-hydration.js";

const repositoryName = "base/repository";
const repositoryAuthority = authority();

test("complete PR coverage persists confirmed absence instead of retained fork identity", async () => {
  const key = `${repositoryName}::feature/fork`;
  const { hydration, persisted, writeOverlays } = hydrationFor({
    branches: ["feature/fork"],
    persisted: {
      [key]: {
        prNumber: 42,
        headRepositoryProvider: VcsProviderKind.GitHub,
        headRepositoryProviderId: "fork-42",
        headRepositoryFullName: "fork/repository",
      },
    },
    pullRequests: [],
  });
  const request = {
    rows: [{ repoFullName: repositoryName, branchName: "feature/fork" }],
    scope: "list" as const,
  };

  const first =
    await hydration.resolveRepositoryDefaultEligibilityInputs(request);
  await waitFor(() => writeOverlays.mock.calls.length > 0);
  const subsequent =
    await hydration.resolveRepositoryDefaultEligibilityInputs(request);

  for (const result of [first, subsequent]) {
    assert.equal(result.overlays?.[key]?.prNumber, null);
    assert.equal(result.overlays?.[key]?.headRepositoryProviderId, undefined);
  }
  assert.equal(persisted[key]?.prNumber, null);
  assert.equal(persisted[key]?.headRepositoryFullName, undefined);
  assert.equal(writeOverlays.mock.calls.length, 1);
});

test("returned PR enrichment survives the eligibility projection and persistence write", async () => {
  const { hydration, writeOverlays } = hydrationFor({
    branches: ["feature/merged", "feature/closed"],
    persisted: {},
    pullRequests: [
      pullRequest(7, "feature/merged", GitHubPRState.Merged, {
        additions: 10,
        changedFiles: 3,
        checksStatus: ChecksStatus.Passing,
        deletions: 4,
        mergedAt: "2026-08-12T11:00:00.000Z",
        reviewDecision: ReviewDecision.Approved,
      }),
      pullRequest(8, "feature/closed", GitHubPRState.Closed),
    ],
  });
  const rows = [
    { repoFullName: repositoryName, branchName: "feature/merged" },
    { repoFullName: repositoryName, branchName: "feature/closed" },
  ];

  const result = await hydration.resolveRepositoryDefaultEligibilityInputs({
    rows,
    scope: "list",
  });
  await waitFor(() => writeOverlays.mock.calls.length > 0);

  const merged = result.overlays?.[`${repositoryName}::feature/merged`];
  assert.equal(merged?.status, BranchStatus.Merged);
  assert.equal(merged?.mergedAt, "2026-08-12T11:00:00.000Z");
  assert.equal(merged?.additions, 10);
  assert.equal(merged?.deletions, 4);
  assert.equal(merged?.filesChanged, 3);
  assert.equal(merged?.checksStatus, ChecksStatus.Passing);
  assert.equal(merged?.reviewDecision, ReviewDecision.Approved);
  assert.equal(
    result.overlays?.[`${repositoryName}::feature/closed`]?.status,
    BranchStatus.Closed
  );
  assert.equal(writeOverlays.mock.calls.length, 1);
});

function hydrationFor(options: {
  branches: readonly string[];
  persisted: Record<string, BranchCloudHydrationOverlay>;
  pullRequests: readonly Record<string, unknown>[];
}) {
  const persisted = options.persisted;
  const writeOverlays = mock.fn(
    (
      _identityKey: string,
      _repoNames: readonly string[],
      overlays: Record<string, BranchCloudHydrationOverlay>
    ) => {
      Object.assign(persisted, overlays);
      return Promise.resolve();
    }
  );
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
                fullName: repositoryName,
                githubRepoId: "base-1",
                source: GitHubRepositorySource.Installation,
                repositoryDefaultAuthority: repositoryAuthority,
              },
            ],
          })
        );
      }
      if (href.includes("/pull-requests")) {
        return Promise.resolve(
          Response.json({
            success: true,
            data: { pullRequests: options.pullRequests },
          })
        );
      }
      return Promise.resolve(
        Response.json({
          success: true,
          data: {
            branches: options.branches.map((name) => ({
              name,
              committedDate: "2026-08-12T10:00:00.000Z",
            })),
          },
        })
      );
    },
    store: {
      readOverlays: () => Promise.resolve(persisted),
      writeOverlays,
      writeRepositoryDefaultAuthorities: () => Promise.resolve(),
      readRepositoryDefaultAuthoritiesByNames: () =>
        Promise.resolve([repositoryAuthority]),
    },
  });
  return { hydration, persisted, writeOverlays };
}

function pullRequest(
  number: number,
  headBranch: string,
  state: GitHubPRState,
  optional: Record<string, unknown> = {}
) {
  return {
    number,
    title: headBranch,
    htmlUrl: `https://github.com/${repositoryName}/pull/${number}`,
    headBranch,
    baseBranch: "main",
    state,
    updatedAt: "2026-08-12T10:30:00.000Z",
    author: "octocat",
    headRepository: repositoryAuthority,
    ...optional,
  };
}

function authority(): RepositoryDefaultAuthority {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: "base-1",
      fullName: repositoryName,
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
      observationKey: "base-1",
      observedAt: "2026-08-12T10:00:00.000Z",
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

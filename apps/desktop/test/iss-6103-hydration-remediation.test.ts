import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BranchCloudHydrationStatus } from "@repo/api/src/types/branch";
import { GitHubRepositorySource } from "@repo/api/src/types/github";
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
import { applyCloudHydration } from "../src/main/branch/shared-branches-cloud-hydration.js";
import {
  isEligibleBranchKey,
  resolveBranchDefaultEligibilitySnapshot,
} from "../src/main/branch/shared-branches-default-eligibility.js";
import {
  buildCurrentEligibilityEvidence,
  type CloudHydrationRequestKind,
} from "../src/main/cloud/desktop-cloud-github-eligibility-authority.js";
import {
  type BranchCloudHydrationOverlay,
  DesktopCloudGitHubHydration,
} from "../src/main/cloud/desktop-cloud-github-hydration.js";
import {
  cloudHydrationCacheIdentity,
  cloudHydrationKeyFingerprint,
} from "../src/main/cloud/desktop-cloud-github-hydration-cache.js";
import {
  readCloudGithubBranchOverlays,
  writeCloudGithubBranchOverlays,
} from "../src/main/database/cloud-github-overlay-store.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeBranchRowFixture } from "./shared-branches-test-helpers.js";

const baseRepositoryName = "base/repository";
const forkRepositoryName = "fork/repository";
const baseAuthority = authority(baseRepositoryName, "base-1", "main");
const forkAuthority = authority(forkRepositoryName, "fork-1", "main");
const forkKey = `${baseRepositoryName}::feature/fork`;

test("capped PR omission preserves exact fork identity but not stale fork authority", async () => {
  const hydration = hydrationFor({
    pullRequestResponse: { pullRequests: [], hasMore: true },
    persistedOverlays: {
      [forkKey]: persistedForkOverlay(),
      [`${baseRepositoryName}::feature/known`]: {
        headRepositoryUnavailableReason: RepositoryDefaultReason.Capped,
      },
    },
    authorities: [baseAuthority, forkAuthority],
  });
  const rows = [
    { repoFullName: baseRepositoryName, branchName: "feature/known" },
    { repoFullName: baseRepositoryName, branchName: "feature/fork" },
  ];
  const inputs = await hydration.resolveRepositoryDefaultEligibilityInputs({
    rows,
    scope: "list",
  });
  const snapshot = await resolveBranchDefaultEligibilitySnapshot(
    rows,
    {
      resolveRepositoryDefaultEligibilityInputs: () => Promise.resolve(inputs),
    },
    { scope: "list" }
  );

  assert.equal(inputs.overlays?.[forkKey]?.prNumber, 42);
  assert.equal(inputs.overlays?.[forkKey]?.headRepositoryProviderId, "fork-1");
  assert.equal(
    inputs.overlays?.[`${baseRepositoryName}::feature/known`]
      ?.headRepositoryUnavailableReason,
    undefined
  );
  assert.equal(
    inputs.authorities.find(
      (candidate) => candidate.repository.fullName === forkRepositoryName
    )?.evidence.availability,
    RepositoryDefaultAvailability.Unavailable
  );
  assert.equal(isEligibleBranchKey(rows[0]!, snapshot), true);
  assert.equal(isEligibleBranchKey(rows[1]!, snapshot), false);
  assert.equal(snapshot?.coverageComplete, false);
});

test("complete PR omission confirms no PR and clears obsolete fork identity", async () => {
  const hydration = hydrationFor({
    pullRequestResponse: { pullRequests: [] },
    persistedOverlays: { [forkKey]: persistedForkOverlay() },
    authorities: [baseAuthority, forkAuthority],
  });
  const row = {
    repoFullName: baseRepositoryName,
    branchName: "feature/fork",
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

  assert.equal(inputs.overlays?.[forkKey]?.prNumber, null);
  assert.equal(inputs.overlays?.[forkKey]?.headRepositoryProviderId, undefined);
  assert.equal(inputs.overlays?.[forkKey]?.headRepositoryFullName, undefined);
  assert.equal(isEligibleBranchKey(row, snapshot), true);
  assert.equal(snapshot?.coverageComplete, true);
  const [hydrated] = await applyCloudHydration(
    [
      makeBranchRowFixture({
        id: "local-fork",
        branchName: row.branchName,
        repoFullName: row.repoFullName,
        prNumber: 42,
        prTitle: "Locally observed PR",
      }),
    ],
    undefined,
    {
      resolvedResult: snapshot?.resolvedHydration,
      scope: "list",
    }
  );
  assert.equal(
    snapshot?.resolvedHydration?.overlays?.[forkKey]?.prNumber,
    null
  );
  assert.equal(hydrated?.prNumber, 42);
  assert.equal(hydrated?.prTitle, "Locally observed PR");
});

test("a branch request failure cannot promote complete repository authority", async () => {
  const hydration = hydrationFor({
    branchFailure: true,
    pullRequestResponse: { pullRequests: [] },
    persistedOverlays: {},
    authorities: [baseAuthority],
  });

  const inputs = await hydration.resolveRepositoryDefaultEligibilityInputs({
    rows: [{ repoFullName: baseRepositoryName, branchName: "feature/known" }],
    scope: "list",
  });

  assert.equal(inputs.status, BranchCloudHydrationStatus.Failed);
  assert.equal(inputs.eligibilityStatus, BranchCloudHydrationStatus.Fresh);
  assert.equal(inputs.failure, "cloud_pull_failed");
});

test("repeated current provenance does not make one authority ambiguous", () => {
  const pullRequestAuthority = {
    ...baseAuthority,
    provenance: {
      ...baseAuthority.provenance,
      source: RepositoryDefaultSource.PullRequestRest,
    },
  };
  const conflictingAuthority = authority(baseRepositoryName, "base-1", "trunk");
  const evidence = buildCurrentEligibilityEvidence(
    [
      baseAuthority,
      pullRequestAuthority,
      pullRequestAuthority,
      conflictingAuthority,
    ],
    new Set(),
    new Set(),
    new Set<CloudHydrationRequestKind>()
  );

  assert.equal(evidence.authorities.length, 2);
  assert.equal(evidence.authorities[0], baseAuthority);
  assert.equal(evidence.authorities[1], conflictingAuthority);
});

test("current repository healing clears cached overrides during a PR-only failure", async () => {
  let healed = false;
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    fetch: (url) => {
      const href = url.toString();
      if (href.endsWith("/repositories")) {
        return Promise.resolve(
          Response.json(repositoryResponse(healed ? baseAuthority : null))
        );
      }
      if (href.includes("/pull-requests")) {
        return healed
          ? Promise.reject(new Error("pull requests unavailable"))
          : Promise.resolve(Response.json(apiData({ pullRequests: [] })));
      }
      return Promise.resolve(Response.json(branchResponse()));
    },
    store: storeFor({}, [baseAuthority]),
  });
  const request = {
    rows: [{ repoFullName: baseRepositoryName, branchName: "feature/known" }],
    scope: "list" as const,
  };
  const initial =
    await hydration.resolveRepositoryDefaultEligibilityInputs(request);
  healed = true;
  const current = await hydration.resolveRepositoryDefaultEligibilityInputs({
    ...request,
    forceRefresh: true,
  });

  assert.equal(
    initial.repositoryDefaultAuthorityOverrides?.[0]?.evidence.availability,
    RepositoryDefaultAvailability.Unavailable
  );
  assert.equal(current.status, BranchCloudHydrationStatus.Stale);
  assert.equal(current.eligibilityStatus, BranchCloudHydrationStatus.Fresh);
  assert.equal(current.failure, "cloud_pull_failed");
  assert.equal(current.repositoryDefaultAuthorityOverrides, undefined);
  assert.equal(current.repositoryDefaultAuthorityUnavailableNames, undefined);
  assert.equal(
    current.authorities[0]?.evidence.availability,
    RepositoryDefaultAvailability.Available
  );
});

for (const prCoverage of ["capped", "failed"] as const) {
  test(`${prCoverage} PR coverage preserves persisted fork identity after write and subsequent read`, async () => {
    assert.deepEqual(await persistedForkIdentityResult(prCoverage), {
      firstPrNumber: 42,
      pullRequestFetches: prCoverage === "capped" ? 1 : 2,
      storedHeadRepositoryFullName: forkRepositoryName,
      storedHeadRepositoryProviderId: "fork-1",
      storedPrNumber: 42,
      subsequentHeadRepositoryProviderId: "fork-1",
      subsequentPrNumber: 42,
    });
  });
}

function hydrationFor(options: {
  authorities: RepositoryDefaultAuthority[];
  branchFailure?: boolean;
  persistedOverlays: Record<string, BranchCloudHydrationOverlay>;
  pullRequestResponse: Record<string, unknown>;
}): DesktopCloudGitHubHydration {
  return new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    fetch: (url) => {
      const href = url.toString();
      if (href.endsWith("/repositories")) {
        return Promise.resolve(
          Response.json(repositoryResponse(baseAuthority))
        );
      }
      if (href.includes("/pull-requests")) {
        return Promise.resolve(
          Response.json(apiData(options.pullRequestResponse))
        );
      }
      return options.branchFailure
        ? Promise.reject(new Error("branches unavailable"))
        : Promise.resolve(Response.json(branchResponse()));
    },
    store: storeFor(options.persistedOverlays, options.authorities),
  });
}

function storeFor(
  overlays: Record<string, BranchCloudHydrationOverlay>,
  authorities: RepositoryDefaultAuthority[]
) {
  return {
    readOverlays: () => Promise.resolve(overlays),
    writeOverlays: () => Promise.resolve(),
    writeRepositoryDefaultAuthorities: () => Promise.resolve(),
    readRepositoryDefaultAuthoritiesByNames: () => Promise.resolve(authorities),
  };
}

function repositoryResponse(
  repositoryDefaultAuthority: RepositoryDefaultAuthority | null
) {
  return apiData([
    {
      id: "base-1",
      fullName: baseRepositoryName,
      githubRepoId: "base-1",
      source: GitHubRepositorySource.Installation,
      repositoryDefaultAuthority,
    },
  ]);
}

function branchResponse() {
  return apiData({
    branches: [
      {
        name: "feature/known",
        committedDate: "2026-08-12T10:00:00.000Z",
      },
      {
        name: "feature/fork",
        committedDate: "2026-08-12T10:00:00.000Z",
      },
    ],
  });
}

function apiData(data: unknown) {
  return { success: true, data };
}

function persistedForkOverlay() {
  return {
    prNumber: 42,
    prTitle: "Persisted fork",
    headRepositoryProvider: VcsProviderKind.GitHub,
    headRepositoryProviderId: "fork-1",
    headRepositoryFullName: forkRepositoryName,
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
    provenance: {
      source: RepositoryDefaultSource.RepositoryRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.SurfaceOpen,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: providerRepositoryId,
      observedAt: "2026-08-12T10:00:00.000Z",
    },
  };
}

async function persistedForkIdentityResult(prCoverage: "capped" | "failed") {
  const directory = await mkdtemp(
    path.join(tmpdir(), `iss-6103-${prCoverage}-persistence-`)
  );
  const database = await openSqliteAgentDatabase({
    dataDir: path.join(directory, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered",
    resolveGitPath: () => "/usr/bin/git",
  });
  const apiKey = "sk_live_test";
  const apiOrigin = "https://api.example.test";
  const identityKey = cloudHydrationCacheIdentity(
    cloudHydrationKeyFingerprint(apiKey),
    apiOrigin,
    null
  );
  let resolveWrite: (() => void) | undefined;
  let rejectWrite: ((error: unknown) => void) | undefined;
  const writeCompleted = new Promise<void>((resolve, reject) => {
    resolveWrite = resolve;
    rejectWrite = reject;
  });
  let pullRequestFetches = 0;
  let readFromDatabase = false;

  try {
    await writeCloudGithubBranchOverlays(
      database.prisma,
      identityKey,
      [baseRepositoryName],
      { [forkKey]: persistedForkOverlay() },
      "2026-08-12T09:00:00.000Z"
    );
    const hydration = new DesktopCloudGitHubHydration({
      getApiKey: () => apiKey,
      getApiOrigin: () => apiOrigin,
      fetch: (url) => {
        const href = url.toString();
        if (href.endsWith("/repositories")) {
          return Promise.resolve(
            Response.json(repositoryResponse(baseAuthority))
          );
        }
        if (href.includes("/pull-requests")) {
          pullRequestFetches += 1;
          return prCoverage === "failed"
            ? Promise.reject(new Error("pull requests unavailable"))
            : Promise.resolve(
                Response.json(apiData({ pullRequests: [], hasMore: true }))
              );
        }
        return Promise.resolve(Response.json(branchResponse()));
      },
      store: {
        readOverlays: (key, repoNames) =>
          readFromDatabase
            ? readCloudGithubBranchOverlays(database.prisma, key, repoNames)
            : Promise.resolve({ [forkKey]: persistedForkOverlay() }),
        writeOverlays: async (key, repoNames, overlays, lastSyncedAt) => {
          try {
            await writeCloudGithubBranchOverlays(
              database.prisma,
              key,
              repoNames,
              overlays,
              lastSyncedAt
            );
            readFromDatabase = true;
            resolveWrite?.();
          } catch (error) {
            rejectWrite?.(error);
            throw error;
          }
        },
        writeRepositoryDefaultAuthorities: () => Promise.resolve(),
        readRepositoryDefaultAuthoritiesByNames: () =>
          Promise.resolve([baseAuthority, forkAuthority]),
      },
    });
    const request = {
      rows: [{ repoFullName: baseRepositoryName, branchName: "feature/fork" }],
      scope: "list" as const,
    };

    const first =
      await hydration.resolveRepositoryDefaultEligibilityInputs(request);
    await writeCompleted;
    const stored = await readCloudGithubBranchOverlays(
      database.prisma,
      identityKey,
      [baseRepositoryName]
    );
    const subsequent =
      await hydration.resolveRepositoryDefaultEligibilityInputs(request);

    return {
      firstPrNumber: first.overlays?.[forkKey]?.prNumber,
      pullRequestFetches,
      storedHeadRepositoryFullName: stored[forkKey]?.headRepositoryFullName,
      storedHeadRepositoryProviderId: stored[forkKey]?.headRepositoryProviderId,
      storedPrNumber: stored[forkKey]?.prNumber,
      subsequentHeadRepositoryProviderId:
        subsequent.overlays?.[forkKey]?.headRepositoryProviderId,
      subsequentPrNumber: subsequent.overlays?.[forkKey]?.prNumber,
    };
  } finally {
    await database.close();
    await rm(directory, { force: true, recursive: true });
  }
}

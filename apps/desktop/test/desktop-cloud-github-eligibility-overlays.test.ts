import assert from "node:assert/strict";
import { test } from "node:test";
import { BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import {
  applyCompletePullRequestCoverageToCandidates,
  applyCurrentAuthorityOverrides,
  buildCloudOverlays,
  collectPullRequestIncompleteReasons,
  mergeCurrentPullRequestOverlay,
  mergeEligibilityOverlays,
  pullRequestHeadRepositoryOverlay,
} from "../src/main/cloud/desktop-cloud-github-eligibility-overlays.js";

test("present contradictory fork authority fails closed as Unknown", () => {
  const overlay = pullRequestHeadRepositoryOverlay({
    headRepository: availableAuthority("fork-id", "fork/repository", "main"),
    headRepositoryUnavailable: {
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason: RepositoryDefaultReason.PermissionDenied,
    },
  });

  assert.deepEqual(overlay, {
    headRepositoryUnavailableReason: RepositoryDefaultReason.Unknown,
  });
});

test("current authority absence replaces only the matching retained repository", () => {
  const omitted = availableAuthority("repo-a", "org/repository-a", "main");
  const unchanged = availableAuthority("repo-b", "org/repository-b", "trunk");
  const replacement = availableAuthority(
    "repo-c",
    "org/repository-c",
    "develop"
  );

  assert.deepEqual(applyCurrentAuthorityOverrides([unchanged], [], []), [
    unchanged,
  ]);
  const result = applyCurrentAuthorityOverrides(
    [omitted, unchanged],
    [replacement],
    ["ORG/REPOSITORY-A"]
  );

  assert.deepEqual(result, [
    {
      repository: omitted.repository,
      evidence: {
        availability: RepositoryDefaultAvailability.Unavailable,
        completeness: RepositoryDefaultCompleteness.Unavailable,
        reason: RepositoryDefaultReason.PermissionFiltered,
      },
    },
    unchanged,
    replacement,
  ]);
});

test("same-PR fork observations merge without weakening a typed absence", () => {
  const identity = {
    prNumber: 7,
    headRepositoryProvider: VcsProviderKind.GitHub,
    headRepositoryProviderId: "fork-7",
    headRepositoryFullName: "fork/repository",
  };
  const denied = {
    prNumber: 7,
    headRepositoryUnavailableReason: RepositoryDefaultReason.PermissionDenied,
  };

  assert.deepEqual(
    mergeCurrentPullRequestOverlay(undefined, identity),
    identity
  );
  assert.equal(
    mergeCurrentPullRequestOverlay(identity, identity).headRepositoryProviderId,
    "fork-7"
  );
  assert.equal(
    mergeCurrentPullRequestOverlay(denied, identity)
      .headRepositoryUnavailableReason,
    RepositoryDefaultReason.PermissionDenied
  );
  assert.equal(
    mergeCurrentPullRequestOverlay(identity, denied)
      .headRepositoryUnavailableReason,
    RepositoryDefaultReason.PermissionDenied
  );
});

test("repository-level PR incompleteness never becomes head-repository absence", () => {
  const capped = {
    repository: { fullName: "org/repository" },
    branches: [
      { name: "known", committedDate: "2026-08-11T00:00:00.000Z" },
      { name: "unseen", committedDate: "2026-08-11T00:00:00.000Z" },
    ],
    pullRequests: [response(12, "known", GitHubPRState.Open).pullRequests[0]!],
    pullRequestIncompleteReason: RepositoryDefaultReason.Capped,
  };

  const overlays = buildCloudOverlays([capped]);

  assert.equal(overlays["org/repository::known"]?.prNumber, 12);
  assert.equal(overlays["org/repository::unseen"]?.prNumber, undefined);
  assert.equal(
    overlays["org/repository::unseen"]?.headRepositoryUnavailableReason,
    undefined
  );
  const reasons = collectPullRequestIncompleteReasons([capped]);
  assert.deepEqual(Object.keys(reasons), ["org/repository"]);
  assert.equal(reasons["org/repository"], RepositoryDefaultReason.Capped);
});

test("incomplete PR coverage preserves exact persisted evidence and drops legacy poison", () => {
  const persistedFork = {
    prNumber: 42,
    prTitle: "Persisted fork",
    headRepositoryProvider: VcsProviderKind.GitHub,
    headRepositoryProviderId: "fork-42",
    headRepositoryFullName: "fork/repository",
  };
  const merged = mergeEligibilityOverlays(
    {
      "ORG/Repository.git::feature/fork": persistedFork,
      "ORG/Repository.git::feature/legacy-capped": {
        headRepositoryUnavailableReason: RepositoryDefaultReason.Capped,
      },
      "org/repository::feature/legacy-error": {
        headRepositoryUnavailableReason: RepositoryDefaultReason.ProviderError,
      },
      "malformed-key": { prTitle: "Retained without interpretation" },
    },
    {
      "org/repository::feature/fork": {
        lastActivityAt: "2026-08-12T10:00:00.000Z",
      },
    },
    { " ORG/Repository.git ": RepositoryDefaultReason.Capped }
  );

  assert.deepEqual(merged["org/repository::feature/fork"], {
    ...persistedFork,
    lastActivityAt: "2026-08-12T10:00:00.000Z",
  });
  assert.deepEqual(merged["org/repository::feature/legacy-capped"], {});
  assert.deepEqual(merged["org/repository::feature/legacy-error"], {});
  assert.deepEqual(merged["malformed-key"], {
    prTitle: "Retained without interpretation",
  });
  assert.equal(merged["ORG/Repository.git::feature/fork"], undefined);
});

test("complete current PR coverage clears obsolete persisted fork evidence", () => {
  const key = "org/repository::feature/fork";
  const current = applyCompletePullRequestCoverageToCandidates(
    {
      [key]: {
        prNumber: 42,
        prTitle: "Stale fork",
        lastActivityAt: "2026-08-12T10:00:00.000Z",
        headRepositoryProvider: VcsProviderKind.GitHub,
        headRepositoryProviderId: "fork-42",
        headRepositoryFullName: "fork/repository",
      },
    },
    new Set(["org/repository"]),
    new Set(),
    [{ repoFullName: "org/repository", branchName: "feature/fork" }]
  );

  assert.deepEqual(current[key], {
    lastActivityAt: "2026-08-12T10:00:00.000Z",
    prNumber: null,
  });
});

test("cloud overlays preserve merged and closed PR lifecycle states", () => {
  const overlays = buildCloudOverlays([
    response(1, "merged", GitHubPRState.Merged),
    response(2, "closed", GitHubPRState.Closed),
  ]);

  assert.equal(overlays["org/repository::merged"]?.status, BranchStatus.Merged);
  assert.equal(overlays["org/repository::closed"]?.status, BranchStatus.Closed);
});

function response(number: number, branch: string, state: GitHubPRState) {
  return {
    repository: { fullName: "org/repository" },
    branches: [{ name: branch, committedDate: "2026-08-11T00:00:00.000Z" }],
    pullRequests: [
      {
        number,
        title: branch,
        htmlUrl: `https://github.com/org/repository/pull/${number}`,
        headBranch: branch,
        baseBranch: "main",
        state,
        updatedAt: "2026-08-11T00:00:00.000Z",
      },
    ],
  };
}

function availableAuthority(
  providerRepositoryId: string,
  fullName: string,
  defaultBranch: string
): NormalizedPersistedRepositoryDefaultAuthority {
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
  };
}

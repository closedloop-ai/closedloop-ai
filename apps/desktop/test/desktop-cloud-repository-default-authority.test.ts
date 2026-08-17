import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { collectCloudRepositoryDefaultAuthorities } from "../src/main/cloud/desktop-cloud-repository-default-authority.js";

test("normalizes PR-head siblings independently without base fallback", () => {
  const forkAuthority = authority("fork-owner/repository", "fork-1", "custom");
  const futureAuthority = {
    ...authority("future-owner/repository", "fork-2", "next"),
    evidence: { availability: "future_availability" },
  };
  const gitLabHeadAuthority = {
    ...authority("gitlab-owner/repository", "fork-3", "main"),
    repository: {
      provider: VcsProviderKind.GitLab,
      providerRepositoryId: "fork-3",
      fullName: "gitlab-owner/repository",
    },
  };
  const observations = collectCloudRepositoryDefaultAuthorities(
    [
      {
        fullName: "closedloop-ai/symphony-alpha",
        githubRepoId: "base-1",
        repositoryDefaultAuthority: { malformed: true },
      },
    ],
    [
      { headRepository: forkAuthority },
      { headRepository: futureAuthority },
      { headRepository: gitLabHeadAuthority },
      { headRepository: { malformed: true } },
      { headRepository: null },
      {
        headRepositoryUnavailable: {
          reason: RepositoryDefaultReason.PermissionDenied,
          provenance: provenance(
            RepositoryDefaultSource.PullRequestGraphql,
            "hidden"
          ),
        },
      },
    ],
    ["closedloop-ai/symphony-alpha"]
  );

  assert.deepEqual(
    observations.map((item) => item.repository.fullName),
    ["fork-owner/repository", "future-owner/repository"]
  );
  assert.equal(
    observations[1]?.evidence.availability,
    RepositoryDefaultAvailability.Unavailable
  );
  assert.equal(
    "reason" in (observations[1]?.evidence ?? {})
      ? observations[1]?.evidence.reason
      : undefined,
    RepositoryDefaultReason.Unknown
  );
  assert.ok(
    !observations.some(
      (item) => item.repository.fullName === "closedloop-ai/symphony-alpha"
    )
  );
});

test("skips nested repository authority that disagrees with outer GitHub identity", () => {
  const repositories = [
    repository(
      "owner/valid",
      "repo-valid",
      authority("owner/valid", "repo-valid", "trunk")
    ),
    repository(
      "owner/full-name-spoof",
      "repo-name-spoof",
      authority("attacker/different", "repo-name-spoof", "main")
    ),
    repository(
      "owner/id-spoof",
      "repo-id-spoof",
      authority("owner/id-spoof", "different-id", "main")
    ),
    repository("owner/provider-spoof", "repo-provider-spoof", {
      ...authority("owner/provider-spoof", "repo-provider-spoof", "main"),
      repository: {
        provider: VcsProviderKind.GitLab,
        providerRepositoryId: "repo-provider-spoof",
        fullName: "owner/provider-spoof",
      },
    }),
  ];

  const observations = collectCloudRepositoryDefaultAuthorities(
    repositories,
    [],
    repositories.map((item) => item.fullName)
  );

  assert.deepEqual(
    observations.map((item) => item.repository.fullName),
    ["owner/valid"]
  );
});

function authority(
  fullName: string,
  providerRepositoryId: string,
  defaultBranch: string
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
      defaultBranch,
    },
    provenance: provenance(RepositoryDefaultSource.RepositoryRest, fullName),
  };
}

function provenance(source: RepositoryDefaultSource, observationKey: string) {
  return {
    source,
    mechanism: GitHubFetchMechanism.Rest,
    trigger: GitHubFetchTrigger.SurfaceOpen,
    credentialType: GitHubFetchCredentialType.GitHubApp,
    observationKey,
    observedAt: "2026-08-11T00:00:00.000Z",
  };
}

function repository(
  fullName: string,
  githubRepoId: string,
  repositoryDefaultAuthority: unknown
) {
  return { fullName, githubRepoId, repositoryDefaultAuthority };
}

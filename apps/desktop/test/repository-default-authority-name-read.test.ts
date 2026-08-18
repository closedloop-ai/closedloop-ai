import assert from "node:assert/strict";
import { test } from "node:test";
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
  MAX_REPOSITORY_DEFAULT_AUTHORITY_BATCH_SIZE,
  persistedAuthorityFromStoredRow,
  readRepositoryDefaultAuthoritiesByNames,
  writeRepositoryDefaultAuthorities,
} from "../src/main/database/repository-default-authority-store.js";
import { openTestPrisma } from "./prisma-test-utils.js";

test("bounded name reads return every stable identity in only the requested account and provider", async () => {
  const opened = await openTestPrisma();
  try {
    await writeRepositoryDefaultAuthorities(opened.prisma, "account-a", [
      authority("repo-1", "Acme/Web", VcsProviderKind.GitHub),
      authority("repo-2", "acme/web", VcsProviderKind.GitHub),
      authority("repo-3", "acme/web", VcsProviderKind.GitLab),
    ]);
    await writeRepositoryDefaultAuthorities(opened.prisma, "account-b", [
      authority("repo-4", "acme/web", VcsProviderKind.GitHub),
    ]);

    const rows = await readRepositoryDefaultAuthoritiesByNames(
      opened.prisma,
      "account-a",
      [
        { provider: VcsProviderKind.GitHub, fullName: "ACME/WEB" },
        { provider: VcsProviderKind.GitHub, fullName: "acme/web" },
      ]
    );
    assert.deepEqual(
      rows.map((row) => row.repository.providerRepositoryId),
      ["repo-1", "repo-2"]
    );
  } finally {
    await opened.close();
  }
});

test("name reads reject an oversized request before querying", async () => {
  const opened = await openTestPrisma();
  try {
    await assert.rejects(
      readRepositoryDefaultAuthoritiesByNames(
        opened.prisma,
        "account-a",
        Array.from(
          { length: MAX_REPOSITORY_DEFAULT_AUTHORITY_BATCH_SIZE + 1 },
          (_, index) => ({
            provider: VcsProviderKind.GitHub,
            fullName: `acme/repo-${index}`,
          })
        )
      )
    );
  } finally {
    await opened.close();
  }
});

test("persisted normalization preserves legacy and malformed groups as typed absence", () => {
  const identity = {
    identityKey: "account-a",
    provider: VcsProviderKind.GitHub,
    providerRepositoryId: "repo-1",
    repoFullName: "acme/web",
  };
  const legacy = persistedAuthorityFromStoredRow(identity);
  assert.ok(legacy && "reason" in legacy.evidence);
  assert.equal(legacy.evidence.reason, RepositoryDefaultReason.LegacyRecord);

  const future = persistedAuthorityFromStoredRow({
    ...identity,
    defaultBranch: "main",
    availability: "future_availability",
    completeness: "future_completeness",
    source: "future_source",
    mechanism: "future_mechanism",
    trigger: "future_trigger",
    credentialType: "future_credential",
    observationKey: "future",
    observedAt: "2026-08-11T00:00:00.000Z",
  });
  assert.ok(future && "reason" in future.evidence);
  assert.equal(future.evidence.reason, RepositoryDefaultReason.Unknown);
});

function authority(
  providerRepositoryId: string,
  fullName: string,
  provider: VcsProviderKind
): RepositoryDefaultAuthority {
  return {
    repository: { provider, providerRepositoryId, fullName },
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
      observedAt: "2026-08-11T00:00:00.000Z",
    },
  };
}

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
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  refreshExistingPublicRepositoryAuthority,
  refreshExistingPublicRepositoryAuthorityInTransaction,
} from "./authority-persistence";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockLogError = vi.mocked(log.error);
const mockLogInfo = vi.mocked(log.info);

const organizationId = "00000000-0000-0000-0000-000000000001";

describe("public repository default authority persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not open a transaction when no authority was mapped", async () => {
    const txSpy = vi.spyOn(withDb, "tx");

    await refreshExistingPublicRepositoryAuthority(
      organizationId,
      "repo-1",
      undefined
    );

    expect(txSpy).not.toHaveBeenCalled();
  });

  it("reports a losing concurrent observation as info, never as a monitored error", async () => {
    const tx = buildTx({
      updated: [],
      stored: {
        fullName: "acme/repo-1",
        defaultBranchObservedAt: new Date("2026-08-10T11:00:00.000Z"),
      },
    });

    await refreshExistingPublicRepositoryAuthorityInTransaction(
      tx as never,
      organizationId,
      "repo-1",
      buildRepositoryAuthority("2026-08-10T10:00:00.000Z")
    );

    expect(mockLogInfo).toHaveBeenCalledWith(
      "github_repository_default_authority_stale_rejected",
      expect.objectContaining({
        githubRepoId: "repo-1",
        repositoryFullName: "acme/repo-1",
      })
    );
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("stays silent when the rejected write is not older than the stored observation", async () => {
    const tx = buildTx({
      updated: [],
      stored: {
        fullName: "acme/repo-1",
        defaultBranchObservedAt: new Date("2026-08-10T10:00:00.000Z"),
      },
    });

    await refreshExistingPublicRepositoryAuthorityInTransaction(
      tx as never,
      organizationId,
      "repo-1",
      buildRepositoryAuthority("2026-08-10T10:00:00.000Z")
    );

    expect(mockLogInfo).not.toHaveBeenCalled();
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("still raises a stored conflict as a monitored error", async () => {
    const tx = buildTx({
      updated: [
        {
          fullName: "acme/repo-1",
          defaultBranchReason: RepositoryDefaultReason.Conflicting,
        },
      ],
      stored: null,
    });

    await refreshExistingPublicRepositoryAuthorityInTransaction(
      tx as never,
      organizationId,
      "repo-1",
      buildRepositoryAuthority("2026-08-10T10:00:00.000Z")
    );

    expect(mockLogError).toHaveBeenCalledWith(
      "github_repository_default_authority_conflict",
      expect.objectContaining({
        githubRepoId: "repo-1",
        repositoryFullName: "acme/repo-1",
      })
    );
    expect(mockLogInfo).not.toHaveBeenCalled();
  });
});

function buildTx(input: {
  updated: { fullName: string; defaultBranchReason: string | null }[];
  stored: { fullName: string; defaultBranchObservedAt: Date } | null;
}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue(input.updated),
    publicRepository: {
      findUnique: vi.fn().mockResolvedValue(input.stored),
    },
  };
}

function buildRepositoryAuthority(
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
      source: RepositoryDefaultSource.RepositoryRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: "attempt-1",
      observedAt,
    },
  };
}

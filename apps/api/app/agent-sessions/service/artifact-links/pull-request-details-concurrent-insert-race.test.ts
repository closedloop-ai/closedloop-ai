/**
 * ISS-11280 branch coverage: the conflict-safe insert's fallback read, for a PR
 * whose repository has no resolved `repositoryId` (a public/observed
 * repository with no GitHub App installation). The existing sibling suites
 * (`pull-request-details.test.ts`, `.branches.test.ts`) cover the
 * repositoryId-present fallback shape and the "no row to read back" throw;
 * neither exercises the repositoryId-absent `where` shape, nor the case where
 * the fallback read actually FINDS the concurrent winner instead of throwing.
 */

import { normalizePersistedRepositoryDefaultAuthority } from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { describe, expect, it, vi } from "vitest";
import { repositoryWithAvailableDefault } from "@/__tests__/support/agent-sessions/branch-ingest.test-harness";
import { prDetailRef } from "@/__tests__/support/agent-sessions/service.test-harness-pr-detail";
import { RepositoryIdentitySource } from "./authority-source-queries";
import { persistSessionPullRequestDetails } from "./pull-request-details";

const ORGANIZATION_ID = "org-1";

describe("insertDesktopPrDetailConflictSafe fallback read (repositoryId absent)", () => {
  it("resolves the concurrent winner found by repositoryFullName when the conflict-safe insert finds no row of its own", async () => {
    const authority = normalizePersistedRepositoryDefaultAuthority(
      {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId: "987",
        fullName: "acme/web",
      },
      repositoryWithAvailableDefault({
        id: "repo-1",
        githubRepoId: "987",
        fullName: "acme/web",
      })
    );
    if (!authority) {
      throw new Error("test authority did not normalize");
    }

    const prCreateManyAndReturn = vi.fn().mockResolvedValue([]);
    const prFindFirst = vi.fn().mockResolvedValue({
      id: "pr-concurrent-winner",
      branchArtifactId: "branch-created",
    });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      branchDetail: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "branch-created" }) },
      pullRequestDetail: {
        findMany: vi.fn().mockResolvedValue([]),
        createManyAndReturn: prCreateManyAndReturn,
        findFirst: prFindFirst,
      },
    };

    const resolved = await persistSessionPullRequestDetails(
      tx as never,
      ORGANIZATION_ID,
      null,
      "session-artifact-1",
      [prDetailRef({ branchName: "feat/x" })],
      // No `repositoryId` on this authority — a public/observed repository
      // with no GitHub App installation on it.
      new Map([
        [
          "acme/web",
          {
            repositoryId: null,
            providerRepositoryId: "987",
            identitySources: new Set([RepositoryIdentitySource.Public]),
            authorities: [authority],
          },
        ],
      ]),
      { shouldUpdatePullRequestLinks: false }
    );

    expect(prFindFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        repositoryFullName: "acme/web",
        number: 42,
        repositoryId: null,
      },
      select: { id: true, branchArtifactId: true },
    });
    expect([...resolved.deferrals.values()]).toEqual([]);
    expect([...resolved.details.values()]).toEqual([
      {
        prDetailId: "pr-concurrent-winner",
        branchArtifactId: "branch-created",
      },
    ]);
  });
});

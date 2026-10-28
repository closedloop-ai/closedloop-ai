/**
 * Shared transaction double for the session→branch materialization lane.
 *
 * Extracted from `branch-links-push-gate.test.ts` (ISS-8148) when ISS-8186's
 * materialization-budget suite needed the same double: a second hand-written
 * copy would let the two suites drift on what the lane is allowed to touch,
 * which is the one thing both of them assert.
 */
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { vi } from "vitest";
import type { SessionBranchRepositoryAuthorityMap } from "@/app/agent-sessions/service/artifact-links/shared";
import type { AgentSessionUpsertTx } from "@/app/agent-sessions/service/records";

import { branchBatchObserver } from "./branch-batch-observer";
import { routeExistingBranchRows } from "./existing-branch-rows-double";

export type BranchLinksTxDouble = {
  tx: AgentSessionUpsertTx;
  branchCreateMany: ReturnType<typeof vi.fn>;
  artifactCreateMany: ReturnType<typeof vi.fn>;
  linkRow: ReturnType<typeof vi.fn>;
  branchDetailFindMany: ReturnType<typeof vi.fn>;
  pushRow: ReturnType<typeof vi.fn>;
  sessionDetailUpdate: ReturnType<typeof vi.fn>;
  queryRaw: ReturnType<typeof vi.fn>;
};

/** Eligible non-default repository authority for every name the test uses. */
export function branchAuthorityMap(
  repositoryFullNames: readonly string[]
): SessionBranchRepositoryAuthorityMap {
  return new Map(
    repositoryFullNames.map((fullName, index) => [
      fullName,
      {
        repositoryId: `repo-${index}`,
        providerRepositoryId: `gh-${index}`,
        identityConflict: false,
        authorities: [
          {
            repository: {
              provider: VcsProviderKind.GitHub,
              providerRepositoryId: `gh-${index}`,
              fullName,
            },
            evidence: {
              availability: RepositoryDefaultAvailability.Available,
              completeness: RepositoryDefaultCompleteness.Complete,
              defaultBranch: "main",
              reason: null,
            },
            provenance: {
              observedAt: "2026-05-01T00:00:00.000Z",
              eventAt: "2026-05-01T00:00:00.000Z",
              observationKey: `obs-${index}`,
              source: RepositoryDefaultSource.RepositoryRest,
              mechanism: GitHubFetchMechanism.Rest,
              trigger: GitHubFetchTrigger.Webhook,
              credentialType: GitHubFetchCredentialType.GitHubApp,
            },
          },
        ],
      },
    ])
  ) as unknown as SessionBranchRepositoryAuthorityMap;
}

/**
 * A transaction double. `existingBranchArtifactId` stands for a branch row that
 * some other producer already materialized (webhook, PR lane, reconciler, or a
 * legacy pre-gate row).
 */
export function makeBranchLinksTx(
  existingBranchArtifactId: string | null = null
): BranchLinksTxDouble {
  const artifactCreateMany = vi.fn().mockResolvedValue({ count: 1 });
  const branchCreateMany = vi.fn().mockResolvedValue({ count: 1 });
  const { linkRow, pushRow, executeRaw } = branchBatchObserver();
  const sessionDetailUpdate = vi.fn().mockResolvedValue({});
  const queryRaw = vi.fn().mockResolvedValue([]);
  const branchDetailFindMany = vi.fn().mockImplementation(({ where }) =>
    Promise.resolve(
      existingBranchArtifactId
        ? where.OR.map((pair: object) => ({
            ...pair,
            artifactId: existingBranchArtifactId,
          }))
        : []
    )
  );
  const tx = {
    $queryRaw: routeExistingBranchRows(branchDetailFindMany, queryRaw),
    $queryRawUnsafe: queryRaw,
    $executeRaw: executeRaw,
    $executeRawUnsafe: executeRaw,
    artifact: { createMany: artifactCreateMany },
    artifactLink: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    branchDetail: {
      findMany: branchDetailFindMany,
      createMany: branchCreateMany,
    },
    // ISS-12552: implementation evidence derivation reads and replaces these.
    agentSessionOperationEvidence: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    sessionDetail: {
      findUnique: vi.fn().mockResolvedValue({ metadata: null }),
      update: sessionDetailUpdate,
    },
  } as unknown as AgentSessionUpsertTx;
  return {
    tx,
    artifactCreateMany,
    branchCreateMany,
    linkRow,
    branchDetailFindMany,
    pushRow,
    sessionDetailUpdate,
    queryRaw,
  };
}

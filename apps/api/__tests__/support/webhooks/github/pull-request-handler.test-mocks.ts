/**
 * Shared Prisma transaction-client stub for the GitHub `pull_request` webhook
 * unit tests. `handlePullRequest` performs every read and write inside a single
 * `withDb.tx` callback, so both `webhook-pull-request.test.ts` (lifecycle
 * actions, repository isolation, transaction behavior) and
 * `webhook-pull-request-linkage.test.ts` (artifact-reference linkage) need the
 * identical delegate surface. This is the one copy of it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { type Mock, vi } from "vitest";

export type PullRequestWebhookTx = {
  $executeRaw: Mock;
  gitHubInstallationRepository: { findFirst: Mock };
  repositoryDefaultObservationReceipt: { createMany: Mock };
  pullRequestDetail: {
    findMany: Mock;
    findUnique: Mock;
    findFirst: Mock;
    upsert: Mock;
    update: Mock;
    updateMany: Mock;
  };
  artifact: {
    findUnique: Mock;
    findFirst: Mock;
    findMany: Mock;
    create: Mock;
    update: Mock;
    updateMany: Mock;
  };
  branchDetail: { findFirst: Mock; update: Mock; updateMany: Mock };
  branchStatusCheck: { deleteMany: Mock };
  artifactLink: {
    aggregate: Mock;
    findFirst: Mock;
    findMany: Mock;
    create: Mock;
  };
};

/**
 * Fresh per-test stub of the transaction client. Delegates the handler reads
 * before deciding whether to write default to the "nothing found" answer so a
 * test only has to state the rows it cares about.
 */
export function createPullRequestWebhookTx(): PullRequestWebhookTx {
  const pullRequestDetailFindUnique = vi.fn();
  return {
    // PRODUCES link creation serializes sibling ranks; this is distinct from
    // the reverted FEA-3658 auto-advance's per-document lock.
    $executeRaw: vi.fn().mockResolvedValue(1),
    gitHubInstallationRepository: {
      findFirst: vi.fn(),
    },
    repositoryDefaultObservationReceipt: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    pullRequestDetail: {
      findMany: vi.fn().mockImplementation(async ({ where }) => {
        const latestLookup = pullRequestDetailFindUnique.mock.results.at(-1);
        const existing = latestLookup
          ? await Promise.resolve(latestLookup.value)
          : null;
        if (!existing?.branchArtifactId) {
          return [];
        }
        const coordinates = where.OR as Record<string, unknown>[];
        const githubId = coordinates.find((item) => "githubId" in item)
          ?.githubId as string;
        const repositoryId = coordinates.find((item) => "repositoryId" in item)
          ?.repositoryId as string;
        const repositoryFullName = coordinates.find(
          (item) => "repositoryFullName" in item
        )?.repositoryFullName as string;
        return [
          {
            id: existing.id,
            branchArtifactId: existing.branchArtifactId,
            githubId:
              existing.githubId === null
                ? null
                : (existing.githubId ?? githubId),
            repositoryId:
              existing.repositoryId === null
                ? null
                : (existing.repositoryId ?? repositoryId),
            repositoryFullName:
              existing.repositoryFullName ?? repositoryFullName,
            number: where.number,
          },
        ];
      }),
      findUnique: pullRequestDetailFindUnique,
      findFirst: vi
        .fn()
        .mockImplementation(
          async (args: {
            where?: { id?: string; branchArtifactId?: string };
          }) => {
            if (!args.where?.id) {
              return null;
            }
            const latestLookup =
              pullRequestDetailFindUnique.mock.results.at(-1);
            const existing = latestLookup
              ? await Promise.resolve(latestLookup.value)
              : null;
            return {
              id: args.where.id,
              branchArtifactId:
                args.where.branchArtifactId ??
                existing?.branchArtifactId ??
                null,
              githubUpdatedAt: existing?.githubUpdatedAt ?? null,
              headRefName: existing?.headRefName ?? null,
            };
          }
        ),
      upsert: vi.fn().mockResolvedValue({ id: "pr-detail-id" }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    artifact: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    branchDetail: {
      findFirst: vi
        .fn()
        .mockImplementation((args: { where?: { artifactId?: string } }) =>
          args.where?.artifactId
            ? Promise.resolve({
                artifactId: args.where.artifactId,
                headSha: null,
              })
            : Promise.resolve(null)
        ),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    branchStatusCheck: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    artifactLink: {
      aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: null } }),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
  };
}

/**
 * Models transaction entry semantics while preserving each test's configured
 * delegate behavior. Nested entries receive the ambient client; separate
 * top-level entries receive distinct doubles.
 */
export function installPullRequestTransactionMock(
  mockWithDbTx: Mock,
  initialTx: PullRequestWebhookTx
): PullRequestWebhookTx[] {
  const transactionContext = new AsyncLocalStorage<PullRequestWebhookTx>();
  const topLevelTxDoubles: PullRequestWebhookTx[] = [];

  mockWithDbTx.mockImplementation(
    async (callback: (tx: PullRequestWebhookTx) => unknown) => {
      const ambientTransaction = transactionContext.getStore();
      if (ambientTransaction) {
        return await callback(ambientTransaction);
      }

      const transaction =
        topLevelTxDoubles.length === 0
          ? initialTx
          : createDelegatingTransactionDouble(initialTx);
      topLevelTxDoubles.push(transaction);
      return await transactionContext.run(transaction, () =>
        callback(transaction)
      );
    }
  );

  return topLevelTxDoubles;
}

function createDelegatingTransactionDouble(
  source: PullRequestWebhookTx
): PullRequestWebhookTx {
  const target = createPullRequestWebhookTx();
  delegateMockCalls(target, source);
  return target;
}

function delegateMockCalls(target: object, source: object): void {
  for (const [key, targetValue] of Object.entries(target)) {
    const sourceValue = (source as Record<string, unknown>)[key];
    if (vi.isMockFunction(targetValue) && vi.isMockFunction(sourceValue)) {
      const targetMock = targetValue as Mock;
      const sourceMock = sourceValue as Mock;
      targetMock.mockImplementation((...args: unknown[]) =>
        sourceMock(...args)
      );
    } else if (
      typeof targetValue === "object" &&
      targetValue !== null &&
      typeof sourceValue === "object" &&
      sourceValue !== null
    ) {
      delegateMockCalls(targetValue, sourceValue);
    }
  }
}

/**
 * Every mutation the webhook can perform, for the "this event must not write
 * anything" assertions. `branchArtifactUpsert` is the mocked
 * `branchService.upsertBranchArtifact`, which writes outside `tx`.
 */
export function pullRequestWebhookWriteMocks(
  tx: PullRequestWebhookTx,
  branchArtifactUpsert: Mock
): Mock[] {
  return [
    branchArtifactUpsert,
    tx.pullRequestDetail.upsert,
    tx.pullRequestDetail.update,
    tx.pullRequestDetail.updateMany,
    tx.artifact.create,
    tx.artifact.update,
    tx.artifact.updateMany,
    tx.branchDetail.update,
    tx.branchDetail.updateMany,
    tx.artifactLink.create,
  ];
}

/**
 * A `persistGitHubBranchActivity` double that enters `withDb.tx` the way the
 * real writer does, so the ambient-join path is exercised instead of mocked
 * away. Every caller awaits the writer and discards its value, so resolving
 * `undefined` is faithful. Returns a reader for the transaction the nested
 * entry received.
 */
export function installNestedBranchActivityProducer(
  mockPersist: Mock,
  mockWithDbTx: Mock
): () => unknown {
  let nestedTransaction: unknown;
  mockPersist.mockImplementation(() =>
    mockWithDbTx((tx: unknown) => {
      nestedTransaction = tx;
      return Promise.resolve(undefined);
    })
  );
  return () => nestedTransaction;
}

/** The linked-plan lookup the merge cascade performs inside the transaction. */
export function stubLinkedPlanMergeCascade(
  tx: PullRequestWebhookTx,
  planArtifactId: string
): void {
  tx.artifactLink.findMany.mockResolvedValueOnce([
    { sourceId: planArtifactId },
  ]);
  tx.artifact.findMany.mockResolvedValueOnce([
    {
      id: planArtifactId,
      subtype: DocumentType.ImplementationPlan,
      status: DocumentStatus.Draft,
    },
  ]);
}

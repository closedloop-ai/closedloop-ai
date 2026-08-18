/**
 * Shared Prisma transaction-client stub for the GitHub `pull_request` webhook
 * unit tests. `handlePullRequest` performs every read and write inside a single
 * `withDb.tx` callback, so both `webhook-pull-request.test.ts` (lifecycle
 * actions, repository isolation, transaction behavior) and
 * `webhook-pull-request-linkage.test.ts` (artifact-reference linkage) need the
 * identical delegate surface. This is the one copy of it.
 */

import { type Mock, vi } from "vitest";

export type PullRequestWebhookTx = {
  $executeRaw: Mock;
  gitHubInstallationRepository: { findFirst: Mock };
  pullRequestDetail: {
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
  artifactLink: { findFirst: Mock; findMany: Mock; create: Mock };
};

/**
 * Fresh per-test stub of the transaction client. Delegates the handler reads
 * before deciding whether to write default to the "nothing found" answer so a
 * test only has to state the rows it cares about.
 */
export function createPullRequestWebhookTx(): PullRequestWebhookTx {
  return {
    // The handler issues no raw SQL. Stubbed so the merge-path regressions can
    // assert that no per-document advisory lock is taken (the reverted
    // FEA-3658 auto-advance took one via `pg_advisory_xact_lock`).
    $executeRaw: vi.fn().mockResolvedValue(1),
    gitHubInstallationRepository: {
      findFirst: vi.fn(),
    },
    pullRequestDetail: {
      findUnique: vi.fn(),
      // FEA-2732: the handler adopts a desktop repo-less row by D2 identity
      // before falling back; default to "no repo-less row" here.
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "pr-detail-id" }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
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
      // D2: (repository_id, branch_name) is no longer unique — the handler
      // resolves an existing branch via findFirst.
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    branchStatusCheck: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    artifactLink: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
  };
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

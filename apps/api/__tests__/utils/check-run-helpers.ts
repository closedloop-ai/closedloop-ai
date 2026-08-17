/**
 * Shared fixtures for the `check_run` webhook handler suites. The handler's
 * tests are split by responsibility (`webhook-check-run-guards.test.ts` covers
 * the early-return guards and provider-failure paths, `webhook-check-run.test.ts`
 * the persistence flows), and both drive the handler with the same event shape
 * and the same Prisma double.
 */

import { vi } from "vitest";
import type { handleCheckRun } from "@/app/webhooks/github/handlers/check-run-handler";
import { makePrDetailRow } from "./pr-detail-helpers";

/** A `branchDetail` row with its current pull-request relation. */
export function makeBranchDetailRow(
  partial: Parameters<typeof makePrDetailRow>[0] & {
    branchName?: string;
    currentPullRequestDetailId?: string | null;
  }
) {
  const pr = makePrDetailRow(partial);
  return {
    artifactId: partial.artifactId,
    branchName: partial.branchName ?? "feature/test-branch",
    checksStatus: partial.checksStatus ?? "UNKNOWN",
    headSha: partial.headSha ?? null,
    currentPullRequestDetailId:
      partial.currentPullRequestDetailId ?? "pr-detail-1",
    currentPullRequestDetail: {
      number: partial.number ?? 0,
      title: partial.title ?? "",
      htmlUrl: partial.externalUrl ?? "",
    },
    artifact: {
      ...pr.artifact,
      organizationId: partial.organizationId ?? "org-1",
    },
  };
}

/** A minimal `check_run` webhook event. */
export function createCheckRunEvent(partial?: {
  action?: string;
  headSha?: string;
  headBranch?: string;
  repositoryId?: number;
  repositoryFullName?: string;
  installationId?: number | null;
  checkRunId?: number;
  checkRunName?: string;
  conclusion?: string;
}): Parameters<typeof handleCheckRun>[0] {
  const hasInstallation = partial?.installationId !== null;
  return {
    action: partial?.action ?? "completed",
    check_run: {
      id: partial?.checkRunId ?? 1,
      name: partial?.checkRunName ?? "ci / test",
      head_sha: partial?.headSha ?? "abc123def456abc123def456abc123def456abc1",
      conclusion: partial?.conclusion ?? "success",
      check_suite: {
        head_branch: partial?.headBranch ?? "feature/test-branch",
      },
    },
    repository: {
      id: partial?.repositoryId ?? 12_345,
      full_name: partial?.repositoryFullName ?? "org/repo",
    },
    ...(hasInstallation !== false && {
      installation: {
        id: partial?.installationId ?? 99,
      },
    }),
  } as Parameters<typeof handleCheckRun>[0];
}

/**
 * The pooled-client and transaction doubles the handler reads. `tx.branchDetail
 * .findFirst` re-reads through `findUnique` so a suite can express the TOCTOU
 * guard by changing what `findUnique` returns between the two reads.
 */
export function createCheckRunDbDoubles() {
  const mockDb = {
    gitHubInstallationRepository: { findFirst: vi.fn() },
    branchDetail: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as any;

  const mockTx = {
    $executeRaw: vi.fn(),
    branchDetail: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    branchStatusCheck: {
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    },
    pullRequestDetail: { update: vi.fn() },
    workstreamEvent: { create: vi.fn() },
  } as any;

  mockDb.branchDetail.findMany.mockImplementation(async (args: any) => {
    if (!args.where.branchName) {
      return [];
    }
    const row = await mockDb.branchDetail.findFirst(args);
    return row ? [row] : [];
  });

  mockTx.branchDetail.findFirst.mockImplementation(async (args: any) => {
    const row = await mockTx.branchDetail.findUnique();
    if (!row || row.deletedAt || row.headSha !== args.where.headSha) {
      return null;
    }
    return {
      artifactId: args.where.artifactId,
      checksStatus: row.checksStatus,
    };
  });

  return { mockDb, mockTx };
}

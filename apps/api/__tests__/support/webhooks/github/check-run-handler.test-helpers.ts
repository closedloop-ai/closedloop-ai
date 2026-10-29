/**
 * Shared fixtures for the `check_run` webhook handler suites. The handler's
 * tests are split by responsibility (`webhook-check-run-guards.test.ts` covers
 * the early-return guards and provider-failure paths, `webhook-check-run.test.ts`
 * the persistence flows), and both drive the handler with the same event shape
 * and the same Prisma double.
 */

import { type Mock, vi } from "vitest";
import { makePrDetailRow } from "@/__tests__/utils/pr-detail-helpers";
import type { handleCheckRun } from "@/app/webhooks/github/handlers/check-run-handler";

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
export function createCheckRunDbDoubles(): CheckRunDbDoubles {
  const mockDb = {
    gitHubInstallationRepository: { findFirst: vi.fn() },
    branchDetail: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };

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
  };

  mockDb.branchDetail.findMany.mockImplementation(
    async (args: { where: { branchName?: string } }) => {
      if (!args.where.branchName) {
        return [];
      }
      const row = await mockDb.branchDetail.findFirst(args);
      return row ? [row] : [];
    }
  );

  mockTx.branchDetail.findFirst.mockImplementation(
    async (args: { where: { artifactId: string; headSha: string } }) => {
      const row = await mockTx.branchDetail.findUnique();
      if (!row || row.deletedAt || row.headSha !== args.where.headSha) {
        return null;
      }
      return {
        artifactId: args.where.artifactId,
        checksStatus: row.checksStatus,
      };
    }
  );

  return { mockDb, mockTx };
}

/** The Prisma surface the `check_run` handler touches, as bare mocks. */
export type CheckRunDbDoubles = {
  mockDb: {
    gitHubInstallationRepository: { findFirst: Mock };
    branchDetail: { findFirst: Mock; findMany: Mock };
  };
  mockTx: {
    $executeRaw: Mock;
    branchDetail: {
      findFirst: Mock;
      findUnique: Mock;
      update: Mock;
      updateMany: Mock;
    };
    branchStatusCheck: { deleteMany: Mock; upsert: Mock };
    pullRequestDetail: { update: Mock };
    workstreamEvent: { create: Mock };
  };
};

export const CHECK_RUN_TERMINAL_MESSAGE =
  "[handleCheckRun] Completed check_run webhook handling";

type LogDouble = (message: string, ...args: unknown[]) => void;

/**
 * Every terminal `check_run` line the handler emitted, with the level it was
 * emitted at (ISS-8450). Reading both levels in one list is what lets a case
 * pin "exactly one terminal line, at this level" rather than only "info was
 * called", which a line logged twice would also satisfy.
 */
export function checkRunTerminalLogs(logDouble: {
  debug: LogDouble;
  info: LogDouble;
}): { fields: unknown; level: string }[] {
  return Object.entries({
    debug: logDouble.debug,
    info: logDouble.info,
  }).flatMap(([level, emit]) =>
    vi
      .mocked(emit)
      .mock.calls.filter(([message]) => message === CHECK_RUN_TERMINAL_MESSAGE)
      .map(([, fields]) => ({ fields, level }))
  );
}

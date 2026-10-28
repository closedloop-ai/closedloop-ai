import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import {
  BranchMaterializationRetryState,
  enqueueBranchMaterializationRetryTx,
} from "./branch-materialization-retry";
import { BranchMaterializationRetryReason } from "./branch-materialization-retry-policy";
import type { BranchRefAggregate } from "./branch-ref-aggregate";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

const RETRY_AGGREGATE: BranchRefAggregate = {
  repositoryFullName: "acme/web",
  branchName: "feat/x",
  method: ArtifactRefMethod.PrCreateOutput,
  relation: ArtifactRefRelation.Created,
  observedAt: "2026-08-25T12:34:00.000Z",
  branchLifecycleEvents: [],
  directParticipation: BranchParticipationKind.Wrote,
  directParticipationMethod: ArtifactRefMethod.PrCreateOutput,
  directParticipationObservedAt: "2026-08-25T12:34:00.000Z",
  pullRequestObserved: true,
  branchRefObserved: false,
};

const WRITE_BRANCH_REF_BIND_INDEX = 6;
const WRITE_ATTEMPTS_BIND_INDEX = 9;
const WRITE_OUTCOME_BIND_INDEX = 14;

describe("Branch materialization retry PR-ref replacement", () => {
  it("replaces stale PR-owned retry identities rather than unioning them", async () => {
    const previousSnapshot = prHeadRetryAggregate(SNAPSHOT_PR_REF_COUNT);
    const currentSnapshot = prHeadRetryAggregate(0);
    const tx = txForExistingRetry(previousSnapshot);

    await enqueueBranchMaterializationRetryTx(asRetryTx(tx), {
      organizationId: "org-1",
      sourceArtifactId: "session-1",
      aggregate: currentSnapshot,
      reason: BranchMaterializationRetryReason.AuthorityUnavailable,
    });

    const upsertQuery = findQuery(
      tx.$queryRaw,
      "INSERT INTO branch_materialization_retries"
    );
    const writtenAggregate = parseJsonObject(
      upsertQuery?.values[WRITE_BRANCH_REF_BIND_INDEX] as string
    );
    expect(prNumbersOf(writtenAggregate)).toEqual(
      Array.from({ length: SNAPSHOT_PR_REF_COUNT }, (_, index) => index + 1)
    );
  });
});

function txForExistingRetry(branchRef: BranchRefAggregate) {
  return {
    $queryRaw: vi.fn((query: SqlLike) => {
      if (query.sql.includes("pg_advisory_xact_lock")) {
        return Promise.resolve([]);
      }
      if (
        query.sql.includes("FROM branch_materialization_retries") &&
        query.sql.includes("FOR UPDATE OF retries")
      ) {
        return Promise.resolve([
          {
            retryId: "retry-1",
            organizationId: "org-1",
            sourceArtifactId: "session-1",
            repositoryFullName: "acme/web",
            branchName: "feat/x",
            branchRef,
            state: BranchMaterializationRetryState.Pending,
            reason: BranchMaterializationRetryReason.AuthorityUnavailable,
            attempts: 1,
            nextAttemptAt: new Date("2026-08-25T13:01:00.000Z"),
            createdAt: new Date("2026-08-25T12:00:00.000Z"),
          },
        ]);
      }
      if (query.sql.includes("INSERT INTO branch_materialization_retries")) {
        return Promise.resolve([
          {
            identityKey: retryIdentityKey(RETRY_AGGREGATE),
            retryId: "retry-1",
            organizationId: "org-1",
            sourceArtifactId: "session-1",
            repositoryFullName: "acme/web",
            branchName: "feat/x",
            attempts: query.values[WRITE_ATTEMPTS_BIND_INDEX],
            outcome: query.values[WRITE_OUTCOME_BIND_INDEX],
          },
        ]);
      }
      return Promise.resolve([]);
    }),
  };
}

function prHeadRetryAggregate(startIndex: number): BranchRefAggregate {
  return {
    ...RETRY_AGGREGATE,
    prRefs: Array.from({ length: SNAPSHOT_PR_REF_COUNT }, (_, index) => ({
      repositoryFullName: "acme/web",
      prNumber: startIndex + index + 1,
      relationTypes: [SessionPrRelationType.Created],
    })),
  };
}

function prNumbersOf(aggregate: Record<string, unknown> | null): number[] {
  if (!Array.isArray(aggregate?.prRefs)) {
    return [];
  }
  return aggregate.prRefs.map((ref) => (ref as { prNumber: number }).prNumber);
}

function retryIdentityKey(aggregate: BranchRefAggregate): string {
  return JSON.stringify([
    "org-1",
    "session-1",
    aggregate.repositoryFullName,
    aggregate.branchName,
  ]);
}

function findQuery(mock: { mock: { calls: unknown[][] } }, marker: string) {
  return mock.mock.calls
    .map((call) => call[0] as SqlLike)
    .find((query) => query.sql.includes(marker));
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asRetryTx(
  tx: unknown
): Parameters<typeof enqueueBranchMaterializationRetryTx>[0] {
  return tx as unknown as Parameters<
    typeof enqueueBranchMaterializationRetryTx
  >[0];
}

type SqlLike = {
  sql: string;
  values: unknown[];
};

/** Past the retired 100-ref cap (ISS-9859), so a reinstated cap would fail. */
const SNAPSHOT_PR_REF_COUNT = 150;

import { Priority } from "@repo/api/src/types/common";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import {
  asRetryTx,
  findAllQueries,
  findQuery,
  parseJsonObject,
  type SqlLike,
} from "@/__tests__/support/agent-sessions/service/artifact-links/branch-materialization-retry.test-helpers";
import {
  deleteBranchMaterializationRetryForMaterializedAggregateTx,
  enqueueBranchMaterializationRetriesTx,
  lockBranchRetryIdentities,
} from "./branch-materialization-retry";
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
  method: "git_commit",
  relation: ArtifactRefRelation.Created,
  observedAt: "2026-08-25T12:34:00.000Z",
  branchLifecycleEvents: [],
};

const WRITE_BRANCH_REF_BIND_INDEX = 6;

describe("Branch materialization retry batch identity preparation", () => {
  it("returns invalid_context without touching the database when no aggregate has a valid identity", async () => {
    const tx = { $queryRaw: vi.fn(), $executeRaw: vi.fn() };

    const results = await enqueueBranchMaterializationRetriesTx(asRetryTx(tx), {
      organizationId: "org-1",
      sourceArtifactId: "session-1",
      aggregates: [{ ...RETRY_AGGREGATE, branchName: "   " }],
    });

    expect(results).toEqual([{ status: "invalid_context" }]);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("marks only the identity-invalid aggregate as invalid_context within a mixed batch", async () => {
    const invalidAggregate = { ...RETRY_AGGREGATE, repositoryFullName: "" };
    const tx = txForBulkInsert([RETRY_AGGREGATE]);

    const results = await enqueueBranchMaterializationRetriesTx(
      asRetryTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        aggregates: [RETRY_AGGREGATE, invalidAggregate],
      },
      new Date("2026-08-25T13:00:00.000Z")
    );

    expect(results).toEqual([
      { status: "scheduled", retryId: "retry-0" },
      { status: "invalid_context" },
    ]);
  });

  it("merges two same-batch aggregates that share one branch identity into a single written row", async () => {
    const earlier = {
      ...RETRY_AGGREGATE,
      observedAt: "2026-08-25T10:00:00.000Z",
      priority: Priority.High,
    };
    const later = {
      ...RETRY_AGGREGATE,
      observedAt: "2026-08-25T12:34:00.000Z",
    };
    // Only one distinct identity exists in this batch, so only one row is
    // ever written — the mock reflects that rather than the two inputs.
    const tx = txForBulkInsert([earlier]);

    const results = await enqueueBranchMaterializationRetriesTx(
      asRetryTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        aggregates: [earlier, later],
      },
      new Date("2026-08-25T13:00:00.000Z")
    );

    expect(results).toEqual([
      { status: "scheduled", retryId: "retry-0" },
      { status: "scheduled", retryId: "retry-0" },
    ]);
    expect(
      findAllQueries(tx.$queryRaw, "INSERT INTO branch_materialization_retries")
    ).toHaveLength(1);
    const upsertQuery = findQuery(
      tx.$queryRaw,
      "INSERT INTO branch_materialization_retries"
    );
    const written = parseJsonObject(
      upsertQuery?.values[WRITE_BRANCH_REF_BIND_INDEX] as string
    );
    // mergeBranchRefAggregates keeps the LATER observedAt, which only holds if
    // the two same-batch entries were actually folded before being written —
    // a dedupe that just dropped the second entry would leave the earlier one.
    expect(written?.observedAt).toBe("2026-08-25T12:34:00.000Z");
    // Only the FIRST-seen entry (`earlier`) carries a priority, and the merge
    // keeps a base field the later entry doesn't override. A same-key
    // "dedupe" that just overwrote the batch map with the later, unmerged
    // aggregate instead of folding the two would lose it.
    expect(written?.priority).toBe(Priority.High);
  });

  it("skips the delete entirely for an aggregate without a valid identity", async () => {
    const tx = { $queryRaw: vi.fn(), $executeRaw: vi.fn() };

    const count =
      await deleteBranchMaterializationRetryForMaterializedAggregateTx(
        asRetryTx(tx),
        {
          organizationId: "org-1",
          sourceArtifactId: "session-1",
          aggregate: { ...RETRY_AGGREGATE, repositoryFullName: "  " },
        }
      );

    expect(count).toBe(0);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("does nothing when there are no identities to lock", async () => {
    const tx = { $queryRaw: vi.fn() };

    await lockBranchRetryIdentities(asRetryTx(tx), []);

    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

function txForBulkInsert(aggregates: readonly BranchRefAggregate[]) {
  const tx = {
    $queryRaw: vi.fn((query: SqlLike) => {
      if (query.sql.includes("pg_advisory_xact_lock")) {
        return Promise.resolve([]);
      }
      if (
        query.sql.includes("FROM branch_materialization_retries") &&
        query.sql.includes("FOR UPDATE OF retries")
      ) {
        return Promise.resolve([]);
      }
      if (query.sql.includes("INSERT INTO branch_materialization_retries")) {
        return Promise.resolve(
          aggregates.map((aggregate, index) => ({
            identityKey: retryIdentityKey(aggregate),
            retryId: `retry-${index}`,
            organizationId: "org-1",
            sourceArtifactId: "session-1",
            repositoryFullName: aggregate.repositoryFullName,
            branchName: aggregate.branchName,
            attempts: 0,
            outcome: "scheduled",
          }))
        );
      }
      return Promise.resolve([]);
    }),
  };
  return tx;
}

function retryIdentityKey(aggregate: BranchRefAggregate): string {
  return JSON.stringify([
    "org-1",
    "session-1",
    aggregate.repositoryFullName,
    aggregate.branchName,
  ]);
}

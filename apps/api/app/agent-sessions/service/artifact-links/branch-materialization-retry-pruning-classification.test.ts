import {
  ArtifactRefRelation,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import {
  asRetryTx,
  findQuery,
  parseJsonObject,
  type SqlLike,
} from "@/__tests__/support/agent-sessions/service/artifact-links/branch-materialization-retry.test-helpers";
import { BranchMaterializationRetryState } from "./branch-materialization-retry";
import { pruneStalePullRequestHeadBranchRetriesTx } from "./branch-materialization-retry-pruning";
import type { BranchRefAggregate } from "./branch-ref-aggregate";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

const NOW = new Date("2026-08-25T13:00:00.000Z");

describe("Branch materialization retry PR-head classification", () => {
  it("leaves a retry row untouched when its evidence is independent branch-ref activity, not a PR head", async () => {
    const tx = pruneTx([
      {
        id: "00000000-0000-4000-8000-000000000010",
        state: BranchMaterializationRetryState.Pending,
        branchRef: branchOnlyAggregate(),
      },
    ]);

    await pruneStalePullRequestHeadBranchRetriesTx(
      asRetryTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        currentPrRefs: [],
      },
      NOW
    );

    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("still treats a branch-ref row as PR-owned when it carries a residual PR identity", async () => {
    const tx = pruneTx([
      {
        id: "00000000-0000-4000-8000-000000000011",
        state: BranchMaterializationRetryState.Pending,
        branchRef: branchOnlyAggregate({ prRefs: [persistedPrRef(9)] }),
      },
    ]);

    await pruneStalePullRequestHeadBranchRetriesTx(
      asRetryTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        // PR 9 is no longer named, so the residual identity is stripped
        // rather than retained.
        currentPrRefs: [],
      },
      NOW
    );

    const rewrite = findQuery(
      tx.$executeRaw,
      "UPDATE branch_materialization_retries"
    );
    const [row] = rewrittenRows(rewrite);
    expect(row.aggregate).not.toHaveProperty("prRefs");
    expect(row.aggregate).not.toHaveProperty("pullRequestObserved");
    expect(row.aggregate).toMatchObject({
      repositoryFullName: "acme/web",
      branchName: "feat/x",
    });
  });

  it("deletes a PR-head retry that has already lost its only PR identity entirely", async () => {
    const tx = pruneTx([
      {
        id: "00000000-0000-4000-8000-000000000012",
        state: BranchMaterializationRetryState.Pending,
        branchRef: prHeadAggregateWithNoRefsField(),
      },
    ]);

    await pruneStalePullRequestHeadBranchRetriesTx(
      asRetryTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        currentPrRefs: [],
      },
      NOW
    );

    const deleteQuery = findQuery(
      tx.$executeRaw,
      "DELETE FROM branch_materialization_retries"
    );
    // A delete aimed at the wrong row, org, or session would still satisfy a
    // bare `toBeDefined()` — pin the actual bound values.
    expect(deleteQuery?.values).toEqual([
      "00000000-0000-4000-8000-000000000012",
      "org-1",
      "session-1",
    ]);
  });
});

function branchOnlyAggregate(
  overrides: Partial<BranchRefAggregate> = {}
): BranchRefAggregate {
  return {
    repositoryFullName: "acme/web",
    branchName: "feat/x",
    method: "git_commit",
    relation: ArtifactRefRelation.Created,
    branchLifecycleEvents: [],
    branchRefObserved: true,
    ...overrides,
  };
}

/** A PR-head retry (`pullRequestObserved: true`) with no `prRefs` at all. */
function prHeadAggregateWithNoRefsField(): BranchRefAggregate {
  return {
    repositoryFullName: "acme/web",
    branchName: "feat/x",
    method: "git_commit",
    relation: ArtifactRefRelation.Created,
    branchLifecycleEvents: [],
    pullRequestObserved: true,
    branchRefObserved: false,
  };
}

function persistedPrRef(prNumber: number) {
  return {
    repositoryFullName: "acme/web",
    prNumber,
    relationTypes: [SessionPrRelationType.Created],
  };
}

function pruneTx(
  rows: Array<{
    id: string;
    state: string;
    branchRef: unknown;
  }>
): PruneTxMock {
  return {
    $queryRaw: vi.fn().mockResolvedValue(rows),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
}

// UPDATE binds `now` first, then four values per rewritten row, then
// organization and session.
function rewrittenRows(query: SqlLike | undefined): RewrittenRow[] {
  const rowValues = query?.values.slice(1, -2) ?? [];
  const rows: RewrittenRow[] = [];
  for (let offset = 0; offset < rowValues.length; offset += 4) {
    rows.push({
      id: rowValues[offset],
      aggregate: parseJsonObject(rowValues[offset + 1] as string),
      state: rowValues[offset + 2],
      claimGenerationDelta: rowValues[offset + 3],
    });
  }
  return rows;
}

type RewrittenRow = {
  id: unknown;
  aggregate: Record<string, unknown> | null;
  state: unknown;
  claimGenerationDelta: unknown;
};

type PruneTxMock = {
  $queryRaw: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
};

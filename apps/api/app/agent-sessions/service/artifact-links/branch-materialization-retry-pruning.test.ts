import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
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

describe("Branch materialization retry PR-head pruning", () => {
  it("rewrites a claimed retry to retain only current PR identities", async () => {
    const tx = pruneTx([
      {
        id: "00000000-0000-4000-8000-000000000001",
        state: BranchMaterializationRetryState.Claimed,
        branchRef: prHeadAggregate({
          prRefs: [persistedPrRef(7), persistedPrRef(8)],
        }),
      },
    ]);

    await pruneStalePullRequestHeadBranchRetriesTx(
      asPruneTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        currentPrRefs: [sessionPrRef(8)],
      },
      NOW
    );

    expect(findExecute(tx.$queryRaw, "FOR UPDATE OF retries")).toBeDefined();
    const rewrite = findExecute(
      tx.$executeRaw,
      "UPDATE branch_materialization_retries"
    );
    const [row] = rewrittenRows(rewrite);
    expect(row.aggregate?.prRefs).toEqual([persistedPrRef(8)]);
    expect(row.state).toBe(BranchMaterializationRetryState.Pending);
    expect(row.claimGenerationDelta).toBe(1);
  });

  it("deletes stale PR-head-only retries with no retained identity", async () => {
    const tx = pruneTx([
      {
        id: "00000000-0000-4000-8000-000000000002",
        state: BranchMaterializationRetryState.Pending,
        branchRef: prHeadAggregate(),
      },
    ]);

    await pruneStalePullRequestHeadBranchRetriesTx(
      asPruneTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        currentPrRefs: [],
      },
      NOW
    );

    expect(
      findExecute(tx.$executeRaw, "DELETE FROM branch_materialization_retries")
    ).toBeDefined();
  });

  it("strips stale PR metadata while preserving independent Branch evidence", async () => {
    const tx = pruneTx([
      {
        id: "00000000-0000-4000-8000-000000000003",
        state: BranchMaterializationRetryState.Pending,
        branchRef: prHeadAggregate({ branchRefObserved: true }),
      },
    ]);

    await pruneStalePullRequestHeadBranchRetriesTx(
      asPruneTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        currentPrRefs: [],
      },
      NOW
    );

    const rewrite = findExecute(
      tx.$executeRaw,
      "UPDATE branch_materialization_retries"
    );
    const [{ aggregate }] = rewrittenRows(rewrite);
    expect(aggregate).toMatchObject({
      repositoryFullName: "acme/web",
      branchName: "feat/x",
    });
    expect(aggregate).not.toHaveProperty("pullRequestObserved");
    expect(aggregate).not.toHaveProperty("prRefs");
  });

  it("preserves legacy PR-vouched retry rows without identity fields", async () => {
    const legacyAggregate = prHeadAggregate({
      branchRefObserved: undefined,
      prRefs: undefined,
    });
    const tx = pruneTx([
      {
        id: "00000000-0000-4000-8000-000000000004",
        state: BranchMaterializationRetryState.Pending,
        branchRef: legacyAggregate,
      },
    ]);

    await pruneStalePullRequestHeadBranchRetriesTx(
      asPruneTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        currentPrRefs: [sessionPrRef(99)],
      },
      NOW
    );

    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("prunes a stale row past the page boundary", async () => {
    const page1 = Array.from({ length: 250 }, (_, i) =>
      makeRow(i + 1, BranchMaterializationRetryState.Pending, prHeadAggregate())
    );
    const stalePastPage = makeRow(
      251,
      BranchMaterializationRetryState.Pending,
      prHeadAggregate()
    );
    const tx = pagedPruneTx([page1, [stalePastPage]]);

    await pruneStalePullRequestHeadBranchRetriesTx(
      asPruneTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        currentPrRefs: [],
      },
      NOW
    );

    const deletes = findAllExecute(
      tx.$executeRaw,
      "DELETE FROM branch_materialization_retries"
    );
    const deletedIds = deletes.flatMap(deletedIdsOf);
    expect(deletedIds).toContain(stalePastPage.id);
    expect(deletedIds).toHaveLength(251);
    expect(deletes).toHaveLength(2);
  });

  it("does not skip or double-process the row at the page boundary", async () => {
    const boundaryRow = makeRow(
      250,
      BranchMaterializationRetryState.Pending,
      prHeadAggregate()
    );
    const page1 = [
      ...Array.from({ length: 249 }, (_, i) =>
        makeRow(
          i + 1,
          BranchMaterializationRetryState.Pending,
          prHeadAggregate({ branchRefObserved: true })
        )
      ),
      boundaryRow,
    ];
    const page2 = [
      makeRow(
        251,
        BranchMaterializationRetryState.Pending,
        prHeadAggregate({ branchRefObserved: true })
      ),
    ];
    const tx = pagedPruneTx([page1, page2]);

    await pruneStalePullRequestHeadBranchRetriesTx(
      asPruneTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        currentPrRefs: [],
      },
      NOW
    );

    const deletes = findAllExecute(
      tx.$executeRaw,
      "DELETE FROM branch_materialization_retries"
    );
    const deletedIds = deletes.flatMap(deletedIdsOf);
    expect(deletedIds.filter((id) => id === boundaryRow.id)).toHaveLength(1);

    const secondQuery = tx.$queryRaw.mock.calls[1][0] as SqlLike;
    expect(secondQuery.values).toContain(boundaryRow.id);
  });

  it("terminates on a short page without a trailing empty read", async () => {
    const tx = pagedPruneTx([
      [
        makeRow(
          1,
          BranchMaterializationRetryState.Pending,
          prHeadAggregate({ branchRefObserved: true })
        ),
      ],
    ]);

    await pruneStalePullRequestHeadBranchRetriesTx(
      asPruneTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        currentPrRefs: [],
      },
      NOW
    );

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("preserves existing per-row outcome for terminal-state rows", async () => {
    const terminalRow = makeRow(
      1,
      BranchMaterializationRetryState.Terminal,
      prHeadAggregate()
    );
    const tx = pagedPruneTx([[terminalRow]]);

    await pruneStalePullRequestHeadBranchRetriesTx(
      asPruneTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        currentPrRefs: [],
      },
      NOW
    );

    const deletes = findAllExecute(
      tx.$executeRaw,
      "DELETE FROM branch_materialization_retries"
    );
    expect(deletes).toHaveLength(1);
    expect(deletedIdsOf(deletes[0])).toEqual([terminalRow.id]);
  });

  it("issues floor(n / pageSize) + 1 selects", async () => {
    const page1 = Array.from({ length: 250 }, (_, i) =>
      makeRow(
        i + 1,
        BranchMaterializationRetryState.Pending,
        prHeadAggregate({ branchRefObserved: true })
      )
    );
    const page2 = Array.from({ length: 250 }, (_, i) =>
      makeRow(
        251 + i,
        BranchMaterializationRetryState.Pending,
        prHeadAggregate({ branchRefObserved: true })
      )
    );
    const page3 = [
      makeRow(
        501,
        BranchMaterializationRetryState.Pending,
        prHeadAggregate({ branchRefObserved: true })
      ),
    ];
    const tx = pagedPruneTx([page1, page2, page3]);

    await pruneStalePullRequestHeadBranchRetriesTx(
      asPruneTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        currentPrRefs: [],
      },
      NOW
    );

    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it("writes each page as one DELETE and one UPDATE, whatever the row count", async () => {
    const stale = Array.from({ length: 120 }, (_, i) =>
      makeRow(i + 1, BranchMaterializationRetryState.Pending, prHeadAggregate())
    );
    const claimedRewrite = makeRow(
      121,
      BranchMaterializationRetryState.Claimed,
      prHeadAggregate({ prRefs: [persistedPrRef(7), persistedPrRef(8)] })
    );
    const pendingRewrites = Array.from({ length: 128 }, (_, i) =>
      makeRow(
        122 + i,
        BranchMaterializationRetryState.Pending,
        prHeadAggregate({ branchRefObserved: true })
      )
    );
    const inSync = makeRow(
      250,
      BranchMaterializationRetryState.Pending,
      prHeadAggregate({ prRefs: [persistedPrRef(8)] })
    );
    const tx = pagedPruneTx([
      [...stale, claimedRewrite, ...pendingRewrites, inSync],
    ]);

    await pruneStalePullRequestHeadBranchRetriesTx(
      asPruneTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        currentPrRefs: [sessionPrRef(8)],
      },
      NOW
    );

    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    const [deleteStatement] = findAllExecute(
      tx.$executeRaw,
      "DELETE FROM branch_materialization_retries"
    );
    expect(deletedIdsOf(deleteStatement)).toEqual(stale.map((row) => row.id));

    const [updateStatement] = findAllExecute(
      tx.$executeRaw,
      "UPDATE branch_materialization_retries"
    );
    const rows = rewrittenRows(updateStatement);
    expect(rows.map((row) => row.id)).toEqual([
      claimedRewrite.id,
      ...pendingRewrites.map((row) => row.id),
    ]);
    expect(rows[0]).toMatchObject({
      state: BranchMaterializationRetryState.Pending,
      claimGenerationDelta: 1,
    });
    expect(rows[0].aggregate?.prRefs).toEqual([persistedPrRef(8)]);
    expect(rows[1]).toMatchObject({
      state: BranchMaterializationRetryState.Pending,
      claimGenerationDelta: 0,
    });
    expect(rows[1].aggregate).not.toHaveProperty("prRefs");
    expect(rows.map((row) => row.id)).not.toContain(inSync.id);
    expect(updateStatement.values).toContain(NOW);
  });
});

function prHeadAggregate(
  overrides: Partial<BranchRefAggregate> = {}
): BranchRefAggregate {
  return {
    repositoryFullName: "acme/web",
    branchName: "feat/x",
    method: ArtifactRefMethod.PrCreateOutput,
    relation: ArtifactRefRelation.Created,
    observedAt: "2026-08-25T12:34:00.000Z",
    branchLifecycleEvents: [],
    pullRequestObserved: true,
    branchRefObserved: false,
    directParticipation: BranchParticipationKind.Wrote,
    directParticipationMethod: ArtifactRefMethod.PrCreateOutput,
    directParticipationObservedAt: "2026-08-25T12:34:00.000Z",
    prRefs: [persistedPrRef(7)],
    ...overrides,
  };
}

function persistedPrRef(prNumber: number) {
  return {
    repositoryFullName: "acme/web",
    prNumber,
    relationTypes: [SessionPrRelationType.Created],
  };
}

function sessionPrRef(prNumber: number) {
  return {
    repositoryFullName: "acme/web",
    prNumber,
    relationType: SessionPrRelationType.Created,
  };
}

function makeRow(
  index: number,
  state: string,
  branchRef: unknown
): { id: string; state: string; branchRef: unknown } {
  const hex = index.toString(16).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8000-${hex}`,
    state,
    branchRef,
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

function pagedPruneTx(
  pages: Array<
    Array<{
      id: string;
      state: string;
      branchRef: unknown;
    }>
  >
): PruneTxMock {
  const queryMock = vi.fn();
  for (const page of pages) {
    queryMock.mockResolvedValueOnce(page);
  }
  queryMock.mockResolvedValue([]);
  return {
    $queryRaw: queryMock,
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
}

function asPruneTx(
  tx: PruneTxMock
): Parameters<typeof pruneStalePullRequestHeadBranchRetriesTx>[0] {
  return tx as unknown as Parameters<
    typeof pruneStalePullRequestHeadBranchRetriesTx
  >[0];
}

function findExecute(mock: { mock: { calls: unknown[][] } }, marker: string) {
  return mock.mock.calls
    .map((call) => call[0] as SqlLike)
    .find((query) => query.sql.includes(marker));
}

function findAllExecute(
  mock: { mock: { calls: unknown[][] } },
  marker: string
) {
  return mock.mock.calls
    .map((call) => call[0] as SqlLike)
    .filter((query) => query.sql.includes(marker));
}

// DELETE binds the page's ids first, then organization and session.
function deletedIdsOf(query: SqlLike): unknown[] {
  return query.values.slice(0, -2);
}

// UPDATE binds now first, then four values per rewritten row, then
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

type SqlLike = {
  sql: string;
  values: unknown[];
};

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

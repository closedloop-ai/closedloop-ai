import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findAllQueries,
  findQuery,
  type SqlLike,
} from "@/__tests__/support/agent-sessions/service/artifact-links/branch-materialization-retry.test-helpers";
import { mocks } from "@/__tests__/support/agent-sessions/service.test-mocks";
import { CloudBranchNonMaterializationKind } from "@/app/branches/branch-write-eligibility";
import { BranchMaterializationStatus } from "./branch-links";
import type { BranchMaterializationRetryClaim } from "./branch-materialization-retry";
import { drainBranchMaterializationRetries } from "./branch-materialization-retry-drain";
import { BranchMaterializationRetryTerminalReason } from "./branch-materialization-retry-monitor";
import { BranchMaterializationRetryPolicy } from "./branch-materialization-retry-policy";
import type { BranchRefAggregate } from "./branch-ref-aggregate";

const { mockLogError, mockMaterialize, mockResolveAuthority } = vi.hoisted(
  () => ({
    mockLogError: vi.fn(),
    mockMaterialize: vi.fn(),
    mockResolveAuthority: vi.fn(),
  })
);

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/log", () => ({
  log: { error: mockLogError, info: vi.fn(), warn: vi.fn() },
}));

vi.mock("./branch-links", () => ({
  BranchMaterializationStatus: {
    Materialized: "materialized",
    NotMaterialized: "not_materialized",
  },
  materializeSessionBranchAggregate: mockMaterialize,
}));

vi.mock("./shared", () => ({
  mergeBranchLifecycleEvents: (
    first: readonly unknown[] | undefined,
    second: readonly unknown[] | undefined
  ) => [...(first ?? []), ...(second ?? [])],
  resolveRepositoryAuthorityByNames: mockResolveAuthority,
}));

const NOW = new Date("2026-08-25T13:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
// Mirrors MAX_CLAIMS_PER_ORG_PER_DRAIN, which the drain module does not export.
const PER_ORG_CLAIM_CAP = 5;
const BUSY_ORG_ID = "org-1";
const QUIET_ORG_ID = "org-2";

const CLAIM_AGGREGATE: BranchRefAggregate = {
  repositoryFullName: "acme/web",
  branchName: "feat/x",
  method: "git_commit",
  relation: ArtifactRefRelation.Created,
  branchLifecycleEvents: [],
};

const CLAIM: BranchMaterializationRetryClaim = {
  id: "retry-1",
  organizationId: "org-1",
  sourceArtifactId: "session-1",
  repositoryFullName: "acme/web",
  branchName: "feat/x",
  branchRef: null,
  attempts: 1,
  claimGeneration: 7,
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  projectId: "project-1",
  validationReason: null,
};

describe("Branch materialization retry drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.tx.mockReset();
    mockResolveAuthority.mockResolvedValue(new Map());
  });

  it("retries once after clearing per-org claim counts before giving up on an empty claim pool", async () => {
    let firstClaimServed = false;
    const tx = {
      $queryRaw: vi.fn((query: SqlLike) => {
        if (query.sql.includes("WITH candidate")) {
          if (!firstClaimServed) {
            firstClaimServed = true;
            return Promise.resolve([
              {
                ...CLAIM,
                validationReason:
                  BranchMaterializationRetryTerminalReason.SourceMissing,
              },
            ]);
          }
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      }),
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    mocks.withDb.tx.mockImplementation((callback) => callback(tx));

    const summary = await drainBranchMaterializationRetries(NOW, 2);

    expect(summary.claimed).toBe(1);
    expect(summary.terminal).toBe(1);
    // Without the fairness-cleared retry, the second (empty) loop iteration
    // would issue exactly one more "WITH candidate" query before giving up —
    // this fixture is only discriminating because it counts all three.
    expect(findAllQueries(tx.$queryRaw, "WITH candidate")).toHaveLength(3);
  });

  it("excludes an org that reaches the per-drain claim cap, then clears the exclusion once only that org has due work", async () => {
    const tx = fairnessDrainTx();
    mocks.withDb.tx.mockImplementation((callback) => callback(tx));

    const summary = await drainBranchMaterializationRetries(
      NOW,
      PER_ORG_CLAIM_CAP + 3
    );

    expect(summary.claimed).toBe(PER_ORG_CLAIM_CAP + 3);
    expect(tx.claimedOrganizationIds).toEqual([
      ...Array.from({ length: PER_ORG_CLAIM_CAP }, () => BUSY_ORG_ID),
      QUIET_ORG_ID,
      BUSY_ORG_ID,
      BUSY_ORG_ID,
    ]);
    // Each claim query's excluded orgs, in order: none until the busy org
    // hits the cap, the busy org for the quiet org's claim and for the empty
    // query after it, then none again once the counts are cleared.
    expect(
      findAllQueries(tx.$queryRaw, "WITH candidate").map(excludedOrganizations)
    ).toEqual([
      ...Array.from({ length: PER_ORG_CLAIM_CAP }, () => []),
      [BUSY_ORG_ID],
      [BUSY_ORG_ID],
      [],
      [],
    ]);
  });

  it("reports a stale claim when a pre-validated terminal claim's fence has moved on", async () => {
    const claim = {
      ...CLAIM,
      validationReason: BranchMaterializationRetryTerminalReason.CorruptState,
    };
    const tx = drainTxForClaim({ claim, executeRawResult: 0 });
    mocks.withDb.tx.mockImplementation((callback) => callback(tx));

    const summary = await drainBranchMaterializationRetries(NOW, 1);

    expect(summary.stale).toBe(1);
    expect(summary.terminal).toBe(0);
    expect(summary.settled).toBe(0);
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("stops before materializing when revalidation finds the claim gone", async () => {
    const tx = drainTxForClaim({ claim: CLAIM, guardMissing: true });
    mocks.withDb.tx.mockImplementation((callback) => callback(tx));

    const summary = await drainBranchMaterializationRetries(NOW, 1);

    expect(summary.stale).toBe(1);
    expect(summary.terminal).toBe(0);
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("settles a non-retryable materialization failure through the terminal-reason mapper", async () => {
    const claim = { ...CLAIM, branchRef: CLAIM_AGGREGATE };
    const tx = drainTxForClaim({ claim, guardBranchRef: CLAIM_AGGREGATE });
    mocks.withDb.tx.mockImplementation((callback) => callback(tx));
    mockMaterialize.mockResolvedValue({
      status: BranchMaterializationStatus.NotMaterialized,
      cause: CloudBranchNonMaterializationKind.ConflictingAuthority,
    });

    const summary = await drainBranchMaterializationRetries(NOW, 1);

    expect(summary.terminal).toBe(1);
    const terminalQuery = findQuery(
      tx.$executeRaw,
      "UPDATE branch_materialization_retries"
    );
    expect(terminalQuery?.values).toContain(
      BranchMaterializationRetryTerminalReason.ConflictingAuthority
    );
  });

  it("reports a stale claim when a successful materialization's settle affects zero rows", async () => {
    const claim = { ...CLAIM, branchRef: CLAIM_AGGREGATE };
    const tx = drainTxForClaim({
      claim,
      guardBranchRef: CLAIM_AGGREGATE,
      executeRawResult: 0,
    });
    mocks.withDb.tx.mockImplementation((callback) => callback(tx));
    mockMaterialize.mockResolvedValue({
      status: BranchMaterializationStatus.Materialized,
      artifactId: "branch-1",
    });

    const summary = await drainBranchMaterializationRetries(NOW, 1);

    expect(summary.stale).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(summary.settled).toBe(0);
  });

  it("dead-letters (and reports stale when its fence moved) a retryable claim once attempts are exhausted", async () => {
    const claim = {
      ...CLAIM,
      attempts: BranchMaterializationRetryPolicy.MaxAttempts,
      branchRef: CLAIM_AGGREGATE,
    };
    const tx = drainTxForClaim({
      claim,
      guardBranchRef: CLAIM_AGGREGATE,
      executeRawResult: 0,
    });
    mocks.withDb.tx.mockImplementation((callback) => callback(tx));
    mockMaterialize.mockResolvedValue({
      status: BranchMaterializationStatus.NotMaterialized,
      cause: CloudBranchNonMaterializationKind.AuthorityUnavailable,
    });

    const summary = await drainBranchMaterializationRetries(NOW, 1);

    expect(summary.stale).toBe(1);
    expect(summary.deadLettered).toBe(0);
    expect(summary.settled).toBe(0);
    // The reschedule path (settleRetryableClaimInTx → rescheduleBranchMaterializationRetry)
    // reports the identical summary when its own UPDATE affects zero rows, so
    // only the bound terminal reason tells this apart from a claim that was
    // rescheduled rather than dead-lettered.
    const terminalQuery = findQuery(
      tx.$executeRaw,
      "UPDATE branch_materialization_retries"
    );
    expect(terminalQuery?.values).toContain(
      BranchMaterializationRetryTerminalReason.AttemptsExhausted
    );
  });

  it("dead-letters a retryable claim whose retry horizon has already elapsed", async () => {
    const claim = {
      ...CLAIM,
      attempts: 2,
      createdAt: new Date(
        NOW.getTime() - BranchMaterializationRetryPolicy.MaxHorizonMs - DAY_MS
      ),
      branchRef: CLAIM_AGGREGATE,
    };
    const tx = drainTxForClaim({ claim, guardBranchRef: CLAIM_AGGREGATE });
    mocks.withDb.tx.mockImplementation((callback) => callback(tx));
    mockMaterialize.mockResolvedValue({
      status: BranchMaterializationStatus.NotMaterialized,
      cause: CloudBranchNonMaterializationKind.AuthorityUnavailable,
    });

    const summary = await drainBranchMaterializationRetries(NOW, 1);

    expect(summary.deadLettered).toBe(1);
    expect(summary.settled).toBe(1);
    const terminalQuery = findQuery(
      tx.$executeRaw,
      "UPDATE branch_materialization_retries"
    );
    expect(terminalQuery?.values).toContain(
      BranchMaterializationRetryTerminalReason.AttemptsExhausted
    );
  });

  it("logs a claim-lease recovery without dead-lettering when attempts remain", async () => {
    const claim = { ...CLAIM, attempts: 1, branchRef: CLAIM_AGGREGATE };
    const tx = drainTxForClaim({ claim, guardBranchRef: CLAIM_AGGREGATE });
    mocks.withDb.tx.mockImplementation((callback) => callback(tx));
    mockMaterialize.mockRejectedValue(new Error("boom"));

    const summary = await drainBranchMaterializationRetries(NOW, 1);

    expect(summary.failed).toBe(1);
    expect(summary.deadLettered).toBe(0);
    expect(summary.settled).toBe(0);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ recovery: "claim_lease" })
    );
  });

  it("logs a rejection when a settled terminal claim carries a blank identity field", async () => {
    const claim = {
      ...CLAIM,
      branchName: "",
      validationReason: BranchMaterializationRetryTerminalReason.SourceMissing,
    };
    const tx = drainTxForClaim({ claim, executeRawResult: 1 });
    mocks.withDb.tx.mockImplementation((callback) => callback(tx));

    const summary = await drainBranchMaterializationRetries(NOW, 1);

    expect(summary.terminal).toBe(1);
    expect(mockLogError).toHaveBeenCalledWith(
      "[branch-materialization-retry] Rejected invalid terminal event",
      expect.objectContaining({ retryId: claim.id })
    );
  });
});

function drainTxForClaim(input: {
  claim: BranchMaterializationRetryClaim;
  executeRawResult?: number;
  guardBranchRef?: unknown;
  guardMissing?: boolean;
}) {
  let claimServed = false;
  return {
    $queryRaw: vi.fn((query: SqlLike) => {
      if (query.sql.includes("WITH candidate")) {
        if (claimServed) {
          return Promise.resolve([]);
        }
        claimServed = true;
        return Promise.resolve([input.claim]);
      }
      if (query.sql.includes('AS "validationReason"')) {
        if (input.guardMissing) {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          {
            validationReason: null,
            branchRef: input.guardBranchRef ?? input.claim.branchRef,
            projectId: input.claim.projectId,
          },
        ]);
      }
      return Promise.resolve([]);
    }),
    $executeRaw: vi.fn().mockResolvedValue(input.executeRawResult ?? 1),
  };
}

/**
 * A claim pool with unlimited due work for the busy org and one due row for
 * the quiet org, ordered so the busy org wins whenever it is not excluded.
 */
function fairnessDrainTx() {
  let quietClaimServed = false;
  const claimedOrganizationIds: string[] = [];
  const serve = (organizationId: string) => {
    claimedOrganizationIds.push(organizationId);
    return Promise.resolve([
      {
        ...CLAIM,
        id: `retry-${claimedOrganizationIds.length}`,
        organizationId,
        validationReason:
          BranchMaterializationRetryTerminalReason.SourceMissing,
      },
    ]);
  };
  return {
    claimedOrganizationIds,
    $queryRaw: vi.fn((query: SqlLike) => {
      if (!query.sql.includes("WITH candidate")) {
        return Promise.resolve([]);
      }
      if (!excludedOrganizations(query).includes(BUSY_ORG_ID)) {
        return serve(BUSY_ORG_ID);
      }
      if (quietClaimServed) {
        return Promise.resolve([]);
      }
      quietClaimServed = true;
      return serve(QUIET_ORG_ID);
    }),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
}

function excludedOrganizations(query: SqlLike): string[] {
  if (!query.sql.includes("NOT IN")) {
    return [];
  }
  return query.values.filter(
    (value): value is string => value === BUSY_ORG_ID || value === QUIET_ORG_ID
  );
}

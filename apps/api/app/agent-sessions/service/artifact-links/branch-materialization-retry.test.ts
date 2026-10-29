import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  ArtifactRefRelation,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mocks } from "@/__tests__/support/agent-sessions/service.test-mocks";
import { CloudBranchNonMaterializationKind } from "@/app/branches/branch-write-eligibility";
import { BranchMaterializationStatus } from "./branch-links";
import {
  type BranchMaterializationRetryClaim,
  BranchMaterializationRetryState,
  deleteBranchMaterializationRetryForMaterializedAggregateTx,
  enqueueBranchMaterializationRetriesTx,
  enqueueBranchMaterializationRetryTx,
  parseBranchMaterializationRetryAggregate,
} from "./branch-materialization-retry";
import { drainBranchMaterializationRetries } from "./branch-materialization-retry-drain";
import {
  BranchMaterializationRetryTerminalReason,
  emitBranchMaterializationRetryEvent,
  isRevivableBranchMaterializationTerminalReason,
} from "./branch-materialization-retry-monitor";
import {
  BranchMaterializationRetryPolicy,
  BranchMaterializationRetryReason,
} from "./branch-materialization-retry-policy";
import type { BranchRefAggregate } from "./branch-ref-aggregate";

const { mockLogError, mockLogWarn, mockMaterialize, mockResolveAuthority } =
  vi.hoisted(() => ({
    mockLogError: vi.fn(),
    mockLogWarn: vi.fn(),
    mockMaterialize: vi.fn(),
    mockResolveAuthority: vi.fn(),
  }));

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/log", () => ({
  log: { error: mockLogError, info: vi.fn(), warn: mockLogWarn },
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

const RETRY_AGGREGATE: BranchRefAggregate = {
  repositoryFullName: "acme/web",
  branchName: "feat/x",
  method: "git_commit",
  relation: ArtifactRefRelation.Created,
  observedAt: "2026-08-25T12:34:00.000Z",
  branchLifecycleEvents: [],
  directParticipation: BranchParticipationKind.Wrote,
  directParticipationMethod: "git_commit",
  directParticipationObservedAt: "2026-08-25T12:34:00.000Z",
};

const CLAIM: BranchMaterializationRetryClaim = {
  id: "retry-1",
  organizationId: "org-1",
  sourceArtifactId: "session-1",
  repositoryFullName: "acme/web",
  branchName: "feat/x",
  branchRef: RETRY_AGGREGATE,
  attempts: 1,
  claimGeneration: 7,
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  projectId: "project-1",
  validationReason: null,
};

describe("Branch materialization retry state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.tx.mockReset();
    mockResolveAuthority.mockResolvedValue(new Map());
    mockMaterialize.mockResolvedValue({
      status: BranchMaterializationStatus.NotMaterialized,
      cause: CloudBranchNonMaterializationKind.AuthorityUnavailable,
    });
  });

  it("invalidates an active claim when enqueue merges stronger evidence", async () => {
    const tx = txForExistingRetry({
      state: BranchMaterializationRetryState.Claimed,
      reason: BranchMaterializationRetryReason.AuthorityUnavailable,
      attempts: 2,
    });

    const result = await enqueueBranchMaterializationRetryTx(asRetryTx(tx), {
      organizationId: "org-1",
      sourceArtifactId: "session-1",
      aggregate: RETRY_AGGREGATE,
      reason: BranchMaterializationRetryReason.AuthorityUnavailable,
    });

    const lockQuery = findQuery(tx.$queryRaw, "pg_advisory_xact_lock");
    const upsertQuery = findQuery(
      tx.$queryRaw,
      "INSERT INTO branch_materialization_retries"
    );
    expect(result).toEqual({ status: "already_scheduled", retryId: "retry-1" });
    expect(lockQuery?.sql.match(/CAST\(\? AS TEXT\)/g)).toHaveLength(2);
    expect(upsertQuery?.sql).toContain("claimed_at = NULL");
    expect(upsertQuery?.sql).toContain(
      "claim_generation = branch_materialization_retries.claim_generation + EXCLUDED.claim_generation"
    );
    expect(upsertQuery?.values).toContain(
      BranchMaterializationRetryState.Pending
    );
    expect(upsertQuery?.values).toContain(1);
  });

  it("bulk enqueues the 500-ref sync contract with one lock/read/write chain", async () => {
    const aggregates = Array.from({ length: 500 }, (_, index) => ({
      ...RETRY_AGGREGATE,
      repositoryFullName: `acme/repo-${index}`,
      branchName: `feat/${index}`,
    }));
    const tx = txForBulkInsert(aggregates);

    const results = await enqueueBranchMaterializationRetriesTx(
      asRetryTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        aggregates,
      },
      new Date("2026-08-25T13:00:00.000Z")
    );

    expect(results).toHaveLength(500);
    expect(results.every((result) => result.status === "scheduled")).toBe(true);
    expect(findAllQueries(tx.$queryRaw, "pg_advisory_xact_lock")).toHaveLength(
      1
    );
    expect(findAllQueries(tx.$queryRaw, "FOR UPDATE OF retries")).toHaveLength(
      1
    );
    expect(
      findAllQueries(tx.$queryRaw, "INSERT INTO branch_materialization_retries")
    ).toHaveLength(1);
    const lockQuery = findQuery(tx.$queryRaw, "pg_advisory_xact_lock");
    const upsertQuery = findQuery(
      tx.$queryRaw,
      "INSERT INTO branch_materialization_retries"
    );
    expect(lockQuery?.sql.match(/CAST\(\? AS TEXT\)/g)).toHaveLength(1000);
    expect(
      upsertQuery?.values.some(
        (value) => typeof value === "string" && value.includes("\0")
      )
    ).toBe(false);
  });

  // ISS-9859: this used to pin the JSONB at the desktop producer's 100-ref cap.
  // That cap is removed (approved 2026-09-10), so every identity is persisted.
  it("persists every retry JSONB PR identity past the retired 100 cap", async () => {
    const overCapAggregate: BranchRefAggregate = {
      ...RETRY_AGGREGATE,
      pullRequestObserved: true,
      branchRefObserved: false,
      prRefs: Array.from(
        { length: PAST_RETIRED_CAP_PR_REF_COUNT },
        (_, index) => ({
          repositoryFullName: "acme/web",
          prNumber: index + 1,
          relationTypes: [SessionPrRelationType.Created],
        })
      ),
    };
    const tx = txForBulkInsert([overCapAggregate]);

    await enqueueBranchMaterializationRetriesTx(
      asRetryTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        aggregates: [overCapAggregate],
      },
      new Date("2026-08-25T13:00:00.000Z")
    );

    const upsertQuery = findQuery(
      tx.$queryRaw,
      "INSERT INTO branch_materialization_retries"
    );
    const writtenAggregate = parseJsonObject(
      upsertQuery?.values[WRITE_BRANCH_REF_BIND_INDEX] as string
    );
    expect(writtenAggregate?.prRefs).toHaveLength(
      PAST_RETIRED_CAP_PR_REF_COUNT
    );
  });

  it("splits an over-ceiling deferred tail across statements and writes every row", async () => {
    // ISS-8186 (whitlockk, #6080). The deferred branch tail is now a routine
    // population, so this enqueue's `VALUES` list is the payload's identity
    // count. At `WRITE_BINDS_PER_ROW` binds each, this fixture is the first row
    // count whose single statement Postgres refuses outright — taking the whole
    // transaction with it, before any retry row is durable.
    const aggregates = Array.from(
      { length: OVER_CEILING_RETRY_ROWS },
      (_, index) => ({
        ...RETRY_AGGREGATE,
        repositoryFullName: `acme/repo-${String(index).padStart(6, "0")}`,
        branchName: `feat/${String(index).padStart(6, "0")}`,
      })
    );
    const tx = txForChunkedBulkInsert();

    const results = await enqueueBranchMaterializationRetriesTx(
      asRetryTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        aggregates,
      },
      new Date("2026-08-25T13:00:00.000Z")
    );

    // The fixture is only discriminating if it really does overflow one
    // statement. Assert that rather than assume it.
    expect(OVER_CEILING_RETRY_ROWS * WRITE_BINDS_PER_ROW).toBeGreaterThan(
      POSTGRES_MAX_BUILT_BIND_PARAMETERS
    );

    // No statement this enqueue issues — lock, read, or write — may exceed the
    // ceiling, whatever its own per-row bind width.
    const statements = tx.$queryRaw.mock.calls.map(
      (call) => call[0] as SqlLike
    );
    for (const statement of statements) {
      expect(statement.values.length).toBeLessThanOrEqual(
        POSTGRES_MAX_BUILT_BIND_PARAMETERS
      );
    }
    expect(
      findAllQueries(tx.$queryRaw, "INSERT INTO branch_materialization_retries")
        .length
    ).toBeGreaterThan(1);

    // Arity alone would stay green for a chunker that dropped its last slice,
    // so read the tail back by identity — that is exactly what a fencepost bug
    // loses.
    expect(results).toHaveLength(OVER_CEILING_RETRY_ROWS);
    expect(results.every((result) => result.status === "scheduled")).toBe(true);
    const written = new Set(
      statements
        .filter((statement) =>
          statement.sql.includes("INSERT INTO branch_materialization_retries")
        )
        .flatMap((statement) => writtenIdentitiesOf(statement))
    );
    expect(written.size).toBe(OVER_CEILING_RETRY_ROWS);
    expect(written.has(retryIdentityKey(aggregates[0]))).toBe(true);
    expect(
      written.has(retryIdentityKey(aggregates[OVER_CEILING_RETRY_ROWS - 1]))
    ).toBe(true);
  });

  // ISS-8229 changes this contract deliberately. Before ISS-8186 the budget did
  // not exist and every branch was judged inline against fresh authority on each
  // sync; now an over-budget tail is judged ONCE in the drain, so a terminal
  // reason that only described the world outlives the condition it named. The
  // condition-terminal reasons therefore revive on a later payload. The
  // identity-terminal ones keep exactly the old behaviour.
  //
  // `not_pushed` is classified Condition but is deliberately NOT driven here
  // (whitlockk, #6140): no writer persists it — the drain treats that cause as
  // retryable BEFORE terminal mapping, and expiry persists as
  // `attempts_exhausted`. ISS-8284 widened
  // `branch_materialization_retries_reason_check` to accept the value, so the
  // database no longer forbids the row; the drain ordering pinned just below is
  // now the whole reason no writer produces one. Its classification stays pinned
  // by the closed-vocabulary test below.
  it.each([
    BranchMaterializationRetryTerminalReason.DefaultBranch,
    BranchMaterializationRetryTerminalReason.ConflictingAuthority,
  ])("revives a %s deferral once a later payload arrives", async (reason) => {
    const tx = txForExistingRetry({
      state: BranchMaterializationRetryState.Terminal,
      reason,
      attempts: 4,
    });

    const result = await enqueueBranchMaterializationRetryTx(asRetryTx(tx), {
      organizationId: "org-1",
      sourceArtifactId: "session-1",
      aggregate: RETRY_AGGREGATE,
      reason: BranchMaterializationRetryReason.AuthorityUnavailable,
    });

    const upsertQuery = findQuery(
      tx.$queryRaw,
      "INSERT INTO branch_materialization_retries"
    );
    expect(result).toEqual({ status: "revived", retryId: "retry-1" });
    expect(upsertQuery?.values[WRITE_STATE_BIND_INDEX]).toBe(
      BranchMaterializationRetryState.Pending
    );
    // The attempt budget restarts, or a revived row would immediately
    // dead-letter on its first drain and the revival would buy nothing.
    expect(upsertQuery?.values[WRITE_ATTEMPTS_BIND_INDEX]).toBe(0);
    expect(upsertQuery?.values[WRITE_CLAIM_GENERATION_BIND_INDEX]).toBe(1);
  });

  it.each([
    BranchMaterializationRetryTerminalReason.CorruptState,
    BranchMaterializationRetryTerminalReason.CrossOrganization,
    BranchMaterializationRetryTerminalReason.IdentityMismatch,
    BranchMaterializationRetryTerminalReason.SourceMissing,
  ])("does not revive a %s deferral on duplicate delivery", async (reason) => {
    const tx = txForExistingRetry({
      state: BranchMaterializationRetryState.Terminal,
      reason,
      attempts: 1,
    });

    const result = await enqueueBranchMaterializationRetryTx(asRetryTx(tx), {
      organizationId: "org-1",
      sourceArtifactId: "session-1",
      aggregate: RETRY_AGGREGATE,
      reason: BranchMaterializationRetryReason.AuthorityUnavailable,
    });

    expect(result).toEqual({ status: "already_scheduled", retryId: "retry-1" });
    expect(
      findQuery(tx.$queryRaw, "INSERT INTO branch_materialization_retries")
    ).toBeUndefined();
  });

  it("does not revive a terminal row whose reason column is unrecognized", async () => {
    const tx = txForExistingRetry({
      state: BranchMaterializationRetryState.Terminal,
      reason: "reason_from_a_future_deploy",
      attempts: 1,
    });

    const result = await enqueueBranchMaterializationRetryTx(asRetryTx(tx), {
      organizationId: "org-1",
      sourceArtifactId: "session-1",
      aggregate: RETRY_AGGREGATE,
      reason: BranchMaterializationRetryReason.AuthorityUnavailable,
    });

    expect(result).toEqual({ status: "already_scheduled", retryId: "retry-1" });
    expect(
      findQuery(tx.$queryRaw, "INSERT INTO branch_materialization_retries")
    ).toBeUndefined();
  });

  it("classifies every terminal reason in the closed vocabulary", () => {
    const classified = Object.values(
      BranchMaterializationRetryTerminalReason
    ).map((reason) => [
      reason,
      isRevivableBranchMaterializationTerminalReason(reason),
    ]);

    expect(Object.fromEntries(classified)).toEqual({
      [BranchMaterializationRetryTerminalReason.AttemptsExhausted]: true,
      [BranchMaterializationRetryTerminalReason.ConflictingAuthority]: true,
      [BranchMaterializationRetryTerminalReason.CorruptState]: false,
      [BranchMaterializationRetryTerminalReason.CrossOrganization]: false,
      [BranchMaterializationRetryTerminalReason.DefaultBranch]: true,
      [BranchMaterializationRetryTerminalReason.IdentityMismatch]: false,
      [BranchMaterializationRetryTerminalReason.NotPushed]: true,
      [BranchMaterializationRetryTerminalReason.SourceMissing]: false,
    });
  });
  // Reviving is only half the claim. This drives the SECOND half of the arc
  // through the real drain: the row the revival left pending is claimed and its
  // Branch artifact is actually written. Deferral that never resumes is a drop.
  it("materializes a revived default-branch deferral on the next drain", async () => {
    const enqueueTx = txForExistingRetry({
      state: BranchMaterializationRetryState.Terminal,
      reason: BranchMaterializationRetryTerminalReason.DefaultBranch,
      attempts: 4,
    });
    const revived = await enqueueBranchMaterializationRetryTx(
      asRetryTx(enqueueTx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        aggregate: RETRY_AGGREGATE,
        reason: BranchMaterializationRetryReason.AuthorityUnavailable,
      }
    );
    expect(revived).toEqual({ status: "revived", retryId: "retry-1" });

    const upsertQuery = findQuery(
      enqueueTx.$queryRaw,
      "INSERT INTO branch_materialization_retries"
    );
    const drainTx = txForDrain({
      claim: {
        ...CLAIM,
        // The drain resumes from the row the revival actually wrote, not from a
        // hand-authored claim that could disagree with it.
        attempts: upsertQuery?.values[WRITE_ATTEMPTS_BIND_INDEX] as number,
        branchRef: RETRY_AGGREGATE,
      },
      guardBranchRef: RETRY_AGGREGATE,
    });
    mocks.withDb.tx.mockImplementation((callback) => callback(drainTx));
    // The default branch moved, so the same aggregate now materializes.
    mockMaterialize.mockResolvedValue({
      status: BranchMaterializationStatus.Materialized,
      artifactId: "branch-1",
    });

    const summary = await drainBranchMaterializationRetries(
      new Date("2026-08-25T13:00:00.000Z"),
      1
    );

    expect(summary.succeeded).toBe(1);
    expect(summary.terminal).toBe(0);
    expect(
      findExecute(
        drainTx.$executeRaw,
        "DELETE FROM branch_materialization_retries"
      )
    ).toBeDefined();
  });

  // The revival's OTHER budget. `attempts` is not the only thing the drain
  // spends: `nextRetryAt` measures MaxHorizonMs from the row's `created_at`, so
  // a revived row that kept the original stamp starts life with a horizon that
  // already elapsed, and the first retryable drain result dead-letters it after
  // one attempt — the revival would buy one attempt instead of a fresh budget.
  it("keeps a revived deferral retryable when the original row outlived the horizon", async () => {
    const enqueueTx = txForExistingRetry({
      state: BranchMaterializationRetryState.Terminal,
      reason: BranchMaterializationRetryTerminalReason.DefaultBranch,
      attempts: 4,
      // Comfortably past the horizon, derived from the policy so a changed
      // bound cannot quietly move this fixture back inside it.
      createdAt: new Date(
        REVIVAL_NOW.getTime() -
          BranchMaterializationRetryPolicy.MaxHorizonMs -
          DAY_MS
      ),
    });

    const revived = await enqueueBranchMaterializationRetryTx(
      asRetryTx(enqueueTx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        aggregate: RETRY_AGGREGATE,
        reason: BranchMaterializationRetryReason.AuthorityUnavailable,
      },
      REVIVAL_NOW
    );
    expect(revived).toEqual({ status: "revived", retryId: "retry-1" });

    const upsertQuery = findQuery(
      enqueueTx.$queryRaw,
      "INSERT INTO branch_materialization_retries"
    );
    const drainTx = txForDrain({
      claim: {
        ...CLAIM,
        // Resume from the row the revival actually wrote. Hand-authoring the
        // anchor here would assert the fixture, not the production write.
        createdAt: upsertQuery?.values[WRITE_CREATED_AT_BIND_INDEX] as Date,
        // The claim statement increments before the drain reads it.
        attempts:
          (upsertQuery?.values[WRITE_ATTEMPTS_BIND_INDEX] as number) + 1,
        branchRef: RETRY_AGGREGATE,
      },
      guardBranchRef: RETRY_AGGREGATE,
    });
    mocks.withDb.tx.mockImplementation((callback) => callback(drainTx));
    // Authority is still unavailable on the first drain after revival — the
    // ordinary retryable result, not a terminal one.
    mockMaterialize.mockResolvedValue({
      status: BranchMaterializationStatus.NotMaterialized,
      cause: CloudBranchNonMaterializationKind.AuthorityUnavailable,
    });

    const summary = await drainBranchMaterializationRetries(REVIVAL_NOW, 1);

    expect(summary.rescheduled).toBe(1);
    expect(summary.deadLettered).toBe(0);
    const settle = findExecute(
      drainTx.$executeRaw,
      "UPDATE branch_materialization_retries"
    );
    expect(settle).toBeDefined();
    expect(settle?.values[SETTLE_STATE_BIND_INDEX]).toBe(
      BranchMaterializationRetryState.Pending
    );
    const nextAttemptAt = settle?.values[SETTLE_NEXT_ATTEMPT_AT_BIND_INDEX];
    expect(nextAttemptAt).toBeInstanceOf(Date);
    expect((nextAttemptAt as Date).getTime()).toBeGreaterThan(
      REVIVAL_NOW.getTime()
    );
  });

  it("rejects malformed persisted timestamps at the JSONB boundary", () => {
    expect(
      parseBranchMaterializationRetryAggregate({
        ...RETRY_AGGREGATE,
        pushedAt: "not-a-date",
      })
    ).toBeNull();
    expect(
      parseBranchMaterializationRetryAggregate({
        ...RETRY_AGGREGATE,
        branchLifecycleEvents: [{ kind: "branch_write", observedAt: "nope" }],
      })
    ).toBeNull();
  });

  it("preserves PR-head-only retry evidence at the JSONB boundary", () => {
    expect(
      parseBranchMaterializationRetryAggregate({
        ...RETRY_AGGREGATE,
        pullRequestObserved: true,
        branchRefObserved: false,
        prRefs: [
          {
            repositoryFullName: "acme/web",
            prNumber: 7,
            relationTypes: [SessionPrRelationType.Created],
          },
        ],
      })
    ).toMatchObject({
      pullRequestObserved: true,
      branchRefObserved: false,
      prRefs: [
        {
          repositoryFullName: "acme/web",
          prNumber: 7,
          relationTypes: [SessionPrRelationType.Created],
        },
      ],
    });
  });

  it("settles corrupt retry payloads before product-visible materialization", async () => {
    const tx = txForDrain({
      claim: {
        ...CLAIM,
        branchRef: { ...RETRY_AGGREGATE, repositoryFullName: "acme/other" },
      },
      guardBranchRef: { ...RETRY_AGGREGATE, repositoryFullName: "acme/other" },
    });
    mocks.withDb.tx.mockImplementation((callback) => callback(tx));

    const summary = await drainBranchMaterializationRetries(
      new Date("2026-08-25T13:00:00.000Z"),
      1
    );

    expect(summary.terminal).toBe(1);
    expect(summary.settled).toBe(1);
    expect(mockMaterialize).not.toHaveBeenCalled();
    const terminalQuery = findExecute(
      tx.$executeRaw,
      "UPDATE branch_materialization_retries"
    );
    expect(terminalQuery?.values).toContain(
      BranchMaterializationRetryTerminalReason.CorruptState
    );
  });

  it("settles PR-head retry payloads without exact PR refs as corrupt", async () => {
    const identitylessPrHeadRetry = {
      ...RETRY_AGGREGATE,
      pullRequestObserved: true,
      branchRefObserved: false,
    };
    const tx = txForDrain({
      claim: {
        ...CLAIM,
        branchRef: identitylessPrHeadRetry,
      },
      guardBranchRef: identitylessPrHeadRetry,
    });
    mocks.withDb.tx.mockImplementation((callback) => callback(tx));

    const summary = await drainBranchMaterializationRetries(
      new Date("2026-08-25T13:00:00.000Z"),
      1
    );

    expect(summary.terminal).toBe(1);
    expect(summary.settled).toBe(1);
    expect(mockMaterialize).not.toHaveBeenCalled();
    const terminalQuery = findExecute(
      tx.$executeRaw,
      "UPDATE branch_materialization_retries"
    );
    expect(terminalQuery?.values).toContain(
      BranchMaterializationRetryTerminalReason.CorruptState
    );
  });

  it("uses the current session project when the claim snapshot was unparented", async () => {
    const tx = txForDrain({
      claim: {
        ...CLAIM,
        projectId: null,
      },
      guardBranchRef: RETRY_AGGREGATE,
      guardProjectId: "project-1",
    });
    mocks.withDb.tx.mockImplementation((callback) => callback(tx));
    mockMaterialize.mockResolvedValue({
      status: BranchMaterializationStatus.Materialized,
      artifactId: "branch-1",
    });

    const summary = await drainBranchMaterializationRetries(
      new Date("2026-08-25T13:00:00.000Z"),
      1
    );

    expect(summary.succeeded).toBe(1);
    expect(mockMaterialize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: "project-1" })
    );
  });

  it("keeps the retry claim lock while writing Branch materialization links", async () => {
    let retryRowLockActive = false;
    const tx = txForDrain({
      claim: CLAIM,
      guardBranchRef: RETRY_AGGREGATE,
      onGuardRead: () => {
        retryRowLockActive = true;
      },
    });
    mocks.withDb.tx.mockImplementation(async (callback) => {
      try {
        return await callback(tx);
      } finally {
        retryRowLockActive = false;
      }
    });
    mockMaterialize.mockImplementation(() => {
      expect(retryRowLockActive).toBe(true);
      return {
        status: BranchMaterializationStatus.Materialized,
        artifactId: "branch-1",
      };
    });

    const summary = await drainBranchMaterializationRetries(
      new Date("2026-08-25T13:00:00.000Z"),
      1
    );

    expect(summary.succeeded).toBe(1);
  });

  it("dead-letters repeated unexpected claim failures at the retry cap", async () => {
    const tx = txForDrain({
      claim: {
        ...CLAIM,
        attempts: 8,
        branchRef: RETRY_AGGREGATE,
      },
      guardBranchRef: RETRY_AGGREGATE,
    });
    mocks.withDb.tx.mockImplementation((callback) => callback(tx));
    mockMaterialize.mockRejectedValue(new Error("boom"));

    const summary = await drainBranchMaterializationRetries(
      new Date("2026-08-25T13:00:00.000Z"),
      1
    );

    expect(summary.failed).toBe(1);
    expect(summary.deadLettered).toBe(1);
    expect(summary.settled).toBe(1);
  });

  it("clears matching retry rows after direct materialization writes the canonical link", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $executeRaw: vi.fn().mockResolvedValue(1),
    };

    await deleteBranchMaterializationRetryForMaterializedAggregateTx(
      asRetryTx(tx),
      {
        organizationId: "org-1",
        sourceArtifactId: "session-1",
        aggregate: RETRY_AGGREGATE,
      }
    );

    const lockQuery = findExecute(tx.$executeRaw, "pg_advisory_xact_lock");
    expect(lockQuery?.sql.match(/CAST\(\? AS TEXT\)/g)).toHaveLength(4);
    expect(
      findExecute(tx.$executeRaw, "DELETE FROM branch_materialization_retries")
    ).toBeDefined();
  });

  it("rejects invalid retry monitor outcome and reason pairings", () => {
    expect(
      emitBranchMaterializationRetryEvent({
        organizationId: "org-1",
        retryId: "retry-1",
        sourceArtifactId: "session-1",
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        outcome: "queued",
        attempts: 0,
        reason: BranchMaterializationRetryTerminalReason.DefaultBranch,
      })
    ).toBe(false);
    expect(mockLogWarn).not.toHaveBeenCalled();
    expect(mockLogError).not.toHaveBeenCalled();
  });
});

function txForExistingRetry(input: {
  state: BranchMaterializationRetryState;
  reason: string | null;
  attempts: number;
  createdAt?: Date;
}) {
  const tx = {
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
            branchRef: RETRY_AGGREGATE,
            state: input.state,
            reason: input.reason,
            attempts: input.attempts,
            nextAttemptAt: new Date("2026-08-25T13:01:00.000Z"),
            createdAt: input.createdAt ?? new Date("2026-08-25T12:00:00.000Z"),
          },
        ]);
      }
      if (query.sql.includes("INSERT INTO branch_materialization_retries")) {
        // Echo the statement's OWN state/attempts/outcome binds rather than a
        // fixed shape: a double that hardcoded `already_scheduled` would report
        // the same status whether or not the production code decided to revive,
        // which is the decision under test.
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
  return tx;
}

/**
 * The ceiling a Prisma-BUILT statement is refused at — the driver counts bind
 * parameters in a SIGNED i16. A literal, not an import from the module under
 * test: deriving the expectation from the constant the production code sizes
 * its chunks with would let a wrong constant silently redefine "over the
 * ceiling" and keep this green. Same reasoning as
 * `ingest-writer-bind-parameter-ceiling.integration.test.ts`.
 */
const POSTGRES_MAX_BUILT_BIND_PARAMETERS = 32_767;

/** Bind parameters one retry row contributes, counted off the INSERT's own VALUES tuple. */
const WRITE_BINDS_PER_ROW = 15;

/** Positions inside that same VALUES tuple. */
const WRITE_BRANCH_REF_BIND_INDEX = 6;
const WRITE_STATE_BIND_INDEX = 7;
const WRITE_ATTEMPTS_BIND_INDEX = 9;
const WRITE_CLAIM_GENERATION_BIND_INDEX = 11;
const WRITE_CREATED_AT_BIND_INDEX = 12;
const WRITE_OUTCOME_BIND_INDEX = 14;

/** Positions inside the settle UPDATE's own bind list. */
const SETTLE_STATE_BIND_INDEX = 0;
const SETTLE_NEXT_ATTEMPT_AT_BIND_INDEX = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
const REVIVAL_NOW = new Date("2026-08-25T13:00:00.000Z");

/** The first row count whose single unchunked statement crosses the ceiling. */
const OVER_CEILING_RETRY_ROWS = 2185;

/**
 * Reconstruct the identities one INSERT statement actually carried, from its
 * own bind values. Reading the statement rather than echoing the caller's whole
 * input is what lets a dropped chunk be visible at all.
 */
function writtenIdentitiesOf(statement: SqlLike): string[] {
  const identities: string[] = [];
  for (
    let offset = 0;
    offset + WRITE_BINDS_PER_ROW <= statement.values.length;
    offset += WRITE_BINDS_PER_ROW
  ) {
    identities.push(
      JSON.stringify([
        "org-1",
        "session-1",
        statement.values[offset + 4],
        statement.values[offset + 5],
      ])
    );
  }
  return identities;
}

/**
 * Unlike {@link txForBulkInsert}, this double answers each INSERT with only the
 * rows THAT statement carried. A double that echoed the caller's full input for
 * every chunk would report a complete result set even when a chunk was never
 * issued, serializing away the condition under test.
 */
function txForChunkedBulkInsert() {
  const tx = {
    $queryRaw: vi.fn((query: SqlLike) => {
      if (!query.sql.includes("INSERT INTO branch_materialization_retries")) {
        return Promise.resolve([]);
      }
      return Promise.resolve(
        writtenIdentitiesOf(query).map((identityKey, index) => {
          const [, , repositoryFullName, branchName] = JSON.parse(
            identityKey
          ) as string[];
          return {
            identityKey,
            retryId: `retry-${index}`,
            organizationId: "org-1",
            sourceArtifactId: "session-1",
            repositoryFullName,
            branchName,
            attempts: 0,
            outcome: "scheduled",
          };
        })
      );
    }),
  };
  return tx;
}

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
function txForDrain(input: {
  claim: typeof CLAIM;
  guardBranchRef: unknown;
  guardProjectId?: string | null;
  onGuardRead?: () => void;
}) {
  let claimReturned = false;
  return {
    $queryRaw: vi.fn((query: SqlLike) => {
      if (query.sql.includes("WITH candidate")) {
        if (claimReturned) {
          return Promise.resolve([]);
        }
        claimReturned = true;
        return Promise.resolve([input.claim]);
      }
      if (query.sql.includes('AS "validationReason"')) {
        input.onGuardRead?.();
        return Promise.resolve([
          {
            validationReason: null,
            branchRef: input.guardBranchRef,
            projectId:
              "guardProjectId" in input
                ? input.guardProjectId
                : input.claim.projectId,
          },
        ]);
      }
      return Promise.resolve([]);
    }),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
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

function findAllQueries(
  mock: { mock: { calls: unknown[][] } },
  marker: string
) {
  return mock.mock.calls
    .map((call) => call[0] as SqlLike)
    .filter((query) => query.sql.includes(marker));
}

function findExecute(mock: { mock: { calls: unknown[][] } }, marker: string) {
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

type SqlLike = {
  sql: string;
  values: unknown[];
};

function asRetryTx(
  tx: unknown
): Parameters<typeof enqueueBranchMaterializationRetryTx>[0] {
  return tx as unknown as Parameters<
    typeof enqueueBranchMaterializationRetryTx
  >[0];
}

/** Past the retired 100-ref cap (ISS-9859), so a reinstated cap would fail. */
const PAST_RETIRED_CAP_PR_REF_COUNT = 150;

import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockWithDb,
  mockEmitZeroCostSessions,
  mockEmitZeroCostBranches,
  mockEmitUnbranchedPrs,
  mockEmitLinesFilesMismatch,
  mockEmitZeroEstimateWithReportedCost,
  mockEmitDualLedgerBranches,
  mockEmitCostEstimateDivergence,
  mockEmitEnrichmentPendingSessions,
  mockEmitEnrichmentPendingPrs,
  mockEmitUnpricedTokenSessions,
  mockEmitOffVocabularyArtifactStatuses,
  mockEmitIntegrationTokensUnencrypted,
  mockEmitCrossOrgProjectAssignees,
  mockCheckCrossOrgProjectAssignees,
} = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockEmitZeroCostSessions: vi.fn(),
  mockEmitZeroCostBranches: vi.fn(),
  mockEmitUnbranchedPrs: vi.fn(),
  mockEmitLinesFilesMismatch: vi.fn(),
  mockEmitZeroEstimateWithReportedCost: vi.fn(),
  mockEmitDualLedgerBranches: vi.fn(),
  mockEmitCostEstimateDivergence: vi.fn(),
  mockEmitEnrichmentPendingSessions: vi.fn(),
  mockEmitEnrichmentPendingPrs: vi.fn(),
  mockEmitUnpricedTokenSessions: vi.fn(),
  mockEmitOffVocabularyArtifactStatuses: vi.fn(),
  mockEmitIntegrationTokensUnencrypted: vi.fn(),
  mockEmitCrossOrgProjectAssignees: vi.fn(),
  // ISS-10989: its raw SQL is exercised against a real database in
  // `__tests__/integration/project-assignee-org-scope.test.ts`, so it is mocked
  // here rather than appended to the positional `$queryRaw` chain below.
  mockCheckCrossOrgProjectAssignees: vi.fn(async () => ({
    count: 0,
    sampleIds: [] as string[],
  })),
}));

vi.mock("@repo/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@repo/database")>();
  return {
    ...original,
    withDb: mockWithDb,
  };
});

vi.mock("@/lib/observability/data-invariant-metrics", () => ({
  emitZeroCostSessions: mockEmitZeroCostSessions,
  emitZeroCostBranches: mockEmitZeroCostBranches,
  emitUnbranchedPrs: mockEmitUnbranchedPrs,
  emitLinesFilesMismatch: mockEmitLinesFilesMismatch,
  emitZeroEstimateWithReportedCost: mockEmitZeroEstimateWithReportedCost,
  emitDualLedgerBranches: mockEmitDualLedgerBranches,
  emitCostEstimateDivergence: mockEmitCostEstimateDivergence,
  emitEnrichmentPendingSessions: mockEmitEnrichmentPendingSessions,
  emitEnrichmentPendingPrs: mockEmitEnrichmentPendingPrs,
  emitUnpricedTokenSessions: mockEmitUnpricedTokenSessions,
  emitOffVocabularyArtifactStatuses: mockEmitOffVocabularyArtifactStatuses,
  emitIntegrationTokensUnencrypted: mockEmitIntegrationTokensUnencrypted,
  emitCrossOrgProjectAssignees: mockEmitCrossOrgProjectAssignees,
}));

vi.mock("./cross-org-project-assignees", () => ({
  checkCrossOrgProjectAssignees: mockCheckCrossOrgProjectAssignees,
}));

import { IntegrationTokenOwner } from "@/lib/observability/integration-token-plaintext-telemetry";
import {
  auditDataInvariants,
  formatViolationCounts,
  VIOLATION_CHECK_KEYS,
} from "./service";

/**
 * Call order the assertions below index into. `auditDataInvariants` runs its
 * checks in this sequence, so a reordering that broke a `mockResolvedValueOnce`
 * chain would surface as a failing count rather than a silently wrong one.
 */
const SESSION_COUNT_CALLS = {
  zeroCostSessions: 0,
  zeroEstimateWithReportedCost: 1,
} as const;

const PR_COUNT_CALLS = {
  unbranchedPrs: 0,
  linesFilesMismatch: 1,
  enrichmentPendingPrs: 2,
} as const;

const makeDb = () => ({
  sessionDetail: {
    count: vi.fn().mockResolvedValue(0),
    findMany: vi.fn().mockResolvedValue([]),
  },
  pullRequestDetail: {
    count: vi.fn().mockResolvedValue(0),
    findMany: vi.fn().mockResolvedValue([]),
  },
  // ISS-7781 gauge 11: one count per table.
  googleIntegration: { count: vi.fn().mockResolvedValue(0) },
  linearIntegration: { count: vi.fn().mockResolvedValue(0) },
  // zero-cost branches (rows) → dual ledger → cost divergence → enrichment →
  // ISS-8515 gauge 9 (per-model breakdown, then the DISTINCT-session total) →
  // ISS-9434 gauge 10 (the artifact status/type group-by).
  // ORDERED: `auditDataInvariants` awaits its checks sequentially, so this chain
  // is positional. Gauge 9 issues TWO raw queries; gauge 10 issues one and is
  // appended LAST.
  $queryRaw: vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ count: 0n }])
    .mockResolvedValueOnce([{ count: 0n }])
    .mockResolvedValueOnce([{ count: 0n }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ total: 0n }])
    .mockResolvedValueOnce([]),
});

describe("auditDataInvariants", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    mockWithDb.mockImplementation((fn: (db: unknown) => unknown) => fn(db));
  });

  it("returns all-zero results when no violations exist", async () => {
    const results = await auditDataInvariants();

    expect(results.totalViolations).toBe(0);
    expect(results.zeroCostSessions.count).toBe(0);
    expect(results.zeroCostBranches.count).toBe(0);
    expect(results.unbranchedPrs.count).toBe(0);
    expect(results.linesFilesMismatch.count).toBe(0);
    expect(results.zeroEstimateWithReportedCost.count).toBe(0);
    expect(results.dualLedgerBranches).toBe(0);
    expect(results.costEstimateDivergence).toBe(0);
    expect(results.enrichmentPendingSessions).toBe(0);
    expect(results.enrichmentPendingPrs).toBe(0);
  });

  it("emits telemetry for every check", async () => {
    await auditDataInvariants();

    expect(mockEmitZeroCostSessions).toHaveBeenCalledWith(0, []);
    expect(mockEmitZeroCostBranches).toHaveBeenCalledWith(0, []);
    expect(mockEmitUnbranchedPrs).toHaveBeenCalledWith(0, []);
    expect(mockEmitLinesFilesMismatch).toHaveBeenCalledWith(0, []);
    expect(mockEmitZeroEstimateWithReportedCost).toHaveBeenCalledWith(0, []);
    expect(mockEmitDualLedgerBranches).toHaveBeenCalledWith(0);
    expect(mockEmitCostEstimateDivergence).toHaveBeenCalledWith(0);
    expect(mockEmitEnrichmentPendingSessions).toHaveBeenCalledWith(0);
    expect(mockEmitEnrichmentPendingPrs).toHaveBeenCalledWith(0);
    expect(mockEmitOffVocabularyArtifactStatuses).toHaveBeenCalledWith(0, []);
    expect(mockEmitCrossOrgProjectAssignees).toHaveBeenCalledWith(0, []);
  });

  it("counts cross-org project assignees as a violation named in the alert (ISS-10989)", async () => {
    mockCheckCrossOrgProjectAssignees.mockResolvedValueOnce({
      count: 2,
      sampleIds: ["project-a", "project-b"],
    });

    const results = await auditDataInvariants();

    expect(results.crossOrgProjectAssignees.count).toBe(2);
    expect(results.totalViolations).toBe(2);
    expect(formatViolationCounts(results)).toContain(
      "crossOrgProjectAssignees=2"
    );
    expect(mockEmitCrossOrgProjectAssignees).toHaveBeenCalledWith(2, [
      "project-a",
      "project-b",
    ]);
  });

  it("counts off-vocabulary artifact statuses as a GAUGE, outside totalViolations (ISS-9434)", async () => {
    // The group-by is the LAST raw query the audit issues; override just it.
    db.$queryRaw.mockReset();
    db.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0n }])
      .mockResolvedValueOnce([{ count: 0n }])
      .mockResolvedValueOnce([{ count: 0n }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }])
      .mockResolvedValueOnce([
        {
          type: ArtifactType.Document,
          subtype: DocumentType.Feature,
          status: DocumentStatus.Obsolete,
          artifact_count: 1n,
        },
        {
          type: ArtifactType.Document,
          subtype: DocumentType.Prd,
          status: DocumentStatus.Draft,
          artifact_count: 900n,
        },
      ]);

    const results = await auditDataInvariants();

    expect(results.offVocabularyArtifactStatuses.count).toBe(1);
    expect(mockEmitOffVocabularyArtifactStatuses).toHaveBeenCalledWith(1, [
      {
        type: ArtifactType.Document,
        subtype: DocumentType.Feature,
        status: DocumentStatus.Obsolete,
        artifactCount: 1,
      },
    ]);
    // The decision that makes this a gauge and not a violation: PLN-1978's
    // census covered one org and a legacy `waiting` population is deliberately
    // still live, so paging on a non-zero count would fire daily. Adding the key
    // to VIOLATION_CHECK_KEYS reddens this line.
    expect(results.totalViolations).toBe(0);
    expect(VIOLATION_CHECK_KEYS).not.toContain("offVocabularyArtifactStatuses");
  });

  it("counts zero-cost metered sessions with substantive activity", async () => {
    db.sessionDetail.count.mockResolvedValueOnce(5);
    db.sessionDetail.findMany.mockResolvedValueOnce([
      { artifactId: "a1" },
      { artifactId: "a2" },
    ]);

    const results = await auditDataInvariants();

    expect(results.zeroCostSessions.count).toBe(5);
    expect(results.zeroCostSessions.sampleIds).toEqual(["a1", "a2"]);
  });

  it("passes metered billing modes to session query", async () => {
    await auditDataInvariants();

    const call =
      db.sessionDetail.count.mock.calls[
        SESSION_COUNT_CALLS.zeroCostSessions
      ][0];
    expect(call.where.billingMode.in).toEqual(
      expect.arrayContaining(["api", "cursor_api"])
    );
    expect(call.where.billingMode.in).toHaveLength(2);
  });

  it("carries exactly the 6 PRICEABLE signals — the invocation count is deliberately absent (ISS-5801)", async () => {
    await auditDataInvariants();

    const call =
      db.sessionDetail.count.mock.calls[
        SESSION_COUNT_CALLS.zeroCostSessions
      ][0];
    // ANDed, not spread: the audit's own `billingMode`/`estimatedCost` keys sit
    // beside the predicate rather than colliding with its `OR`.
    const orClauses = call.where.AND[0].OR;

    const fieldNames = orClauses.map(
      (clause: Record<string, unknown>) => Object.keys(clause)[0]
    );
    expect(fieldNames).toEqual([
      "turns",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "toolUseCount",
    ]);
  });

  it("counts PRs whose parent artifact is not a BRANCH", async () => {
    db.pullRequestDetail.count.mockResolvedValueOnce(3);
    db.pullRequestDetail.findMany.mockResolvedValueOnce([
      { id: "pr1" },
      { id: "pr2" },
      { id: "pr3" },
    ]);

    const results = await auditDataInvariants();

    expect(results.unbranchedPrs.count).toBe(3);
    expect(results.unbranchedPrs.sampleIds).toEqual(["pr1", "pr2", "pr3"]);

    const call =
      db.pullRequestDetail.count.mock.calls[PR_COUNT_CALLS.unbranchedPrs][0];
    expect(call.where.branchArtifact).toEqual({
      is: { type: { not: ArtifactType.Branch } },
    });
  });

  it("never keys the unbranched-PR check on the vestigial artifactId column", async () => {
    // Regression: `artifactId` was the table's PK before the branch-artifact
    // migration and every current writer omits it, so NULL is the normal state
    // of a healthy PR row. Keying here matched every newly ingested PR and
    // would page Slack on a clean database.
    await auditDataInvariants();

    const call =
      db.pullRequestDetail.count.mock.calls[PR_COUNT_CALLS.unbranchedPrs][0];
    expect(call.where).not.toHaveProperty("artifactId");
  });

  it("counts lines/files mismatch", async () => {
    db.pullRequestDetail.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2);
    db.pullRequestDetail.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "m1" }, { id: "m2" }]);

    const results = await auditDataInvariants();

    expect(results.linesFilesMismatch.count).toBe(2);
    expect(results.linesFilesMismatch.sampleIds).toEqual(["m1", "m2"]);
  });

  it("treats an unknown changedFiles as unknown, not as zero", async () => {
    // Regression: `pullRequestLocData` is omission-preserving, so a provider
    // payload with `additions` but no `changedFiles` leaves NULL meaning
    // "unknown". Admitting NULL here alerted on valid partially-enriched rows.
    await auditDataInvariants();

    const call =
      db.pullRequestDetail.count.mock.calls[
        PR_COUNT_CALLS.linesFilesMismatch
      ][0];
    expect(call.where.changedFiles).toBe(0);
    expect(call.where.OR).toBeUndefined();
  });

  it("counts sessions where Claude reported cost but the estimate is $0", async () => {
    db.sessionDetail.count.mockResolvedValueOnce(0).mockResolvedValueOnce(4);
    db.sessionDetail.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ artifactId: "s1" }]);

    const results = await auditDataInvariants();

    expect(results.zeroEstimateWithReportedCost.count).toBe(4);
    expect(results.zeroEstimateWithReportedCost.sampleIds).toEqual(["s1"]);
  });

  it("admits only a reported cost above zero, and now a zero OR UNKNOWN estimate", async () => {
    // `authoritativeCostUsd` is nullable with no default; a stored 0 is a
    // REPORTED zero and a real measurement, so neither shape is a violation.
    await auditDataInvariants();

    const call =
      db.sessionDetail.count.mock.calls[
        SESSION_COUNT_CALLS.zeroEstimateWithReportedCost
      ][0];
    expect(call.where.authoritativeCostUsd.gt.toString()).toBe("0");
    // ISS-8515 — DELIBERATE EXPECTATION CHANGE, not a repair. This asserted
    // `call.where.estimatedCost.equals` and could not survive, because the cost
    // side of check 5 is now an OR and an OR predicate has no `.equals`. Ruling 2
    // changed the behaviour: a session where Claude reported real spend while our
    // estimator produced NOTHING is a violation exactly as much as one it priced
    // at $0, and leaving `= 0` here would have let that population fall out of
    // both check 5 and check 7 (which requires `estimated_cost > 0`) as nulls
    // became reachable. Asserted as the SHAPE so a revert to the zero-only
    // predicate fails rather than passing quietly.
    // Read from `AND[0]`, not the top level: the fragment is COMPOSED into `AND`
    // rather than spread, so a sibling `OR` added to this filter later cannot
    // clobber the cost predicate. Asserting the position is what stops a future
    // edit from silently reverting to the spread.
    const costArms = (
      call.where.AND as Array<{ OR: Record<string, unknown>[] }>
    )[0].OR;
    expect(costArms).toHaveLength(2);
    expect(costArms[0]).toEqual({ estimatedCost: null });
    expect(
      (
        costArms[1].estimatedCost as { equals: { toString(): string } }
      ).equals.toString()
    ).toBe("0");
  });

  it("check 1 admits a NULL cost as well as a zero, at AND[1]", async () => {
    // ISS-8515. Pinned as the SHAPE at a fixed index, not merely "the fragment
    // exists somewhere": the count/findMany mocks return queued values regardless
    // of predicate, so a behavioural assertion alone stays green under a full
    // revert to the zero-only predicate. AND[0] must remain the priceable
    // predicate — a sibling test reads `AND[0].OR` for its field names.
    await auditDataInvariants();

    const call =
      db.sessionDetail.count.mock.calls[
        SESSION_COUNT_CALLS.zeroCostSessions
      ][0];
    // The old top-level key must be GONE. Left beside the AND array, Prisma
    // implicitly ANDs it and the whole predicate collapses back to `= 0`,
    // which would make this widening silently inert in production.
    expect(call.where).not.toHaveProperty("estimatedCost");
    const costArms = call.where.AND[1].OR as Record<string, unknown>[];
    expect(costArms[0]).toEqual({ estimatedCost: null });
    expect(
      (
        costArms[1].estimatedCost as { equals: { toString(): string } }
      ).equals.toString()
    ).toBe("0");
  });

  it("check 2 widens BOTH raw queries, including the exact-count fallback", async () => {
    // The fallback (service.ts) is a SECOND query that only runs when the page
    // returns exactly MAX_SAMPLE_IDS. A one-row fixture passes with
    // the page query widened while the fallback still says `= 0`, silently
    // undercounting every population above ten — so this case forces it.
    const fullPage = Array.from({ length: 10 }, (_, index) => ({
      branch_artifact_id: `b${index}`,
      session_count: 1n,
    }));
    db.$queryRaw.mockReset();
    db.$queryRaw
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce([{ total: 42n }])
      .mockResolvedValueOnce([{ count: 0n }])
      .mockResolvedValueOnce([{ count: 0n }])
      .mockResolvedValueOnce([{ count: 0n }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }])
      // ISS-9434: gauge 10's group-by, appended last.
      .mockResolvedValueOnce([]);

    const results = await auditDataInvariants();

    expect(results.zeroCostBranches.count).toBe(42);
    // Assert the SQL TEXT of both queries: the mock returns queued values
    // whatever the predicate, so only the emitted SQL proves the widening.
    const [pageSql, fallbackSql] = db.$queryRaw.mock.calls.map(
      (call: unknown[]) => JSON.stringify(call)
    );
    expect(pageSql).toContain("IS NULL");
    expect(fallbackSql).toContain("IS NULL");
    // ISS-12142: the error-ended exclusion reaches the count as well as the page.
    expect(pageSql).toContain(ERROR_ENDED_EXCLUSION_SQL);
    expect(fallbackSql).toContain(ERROR_ENDED_EXCLUSION_SQL);
  });

  it("gauge 9 counts unpriced token-bearing sessions and labels them by model", async () => {
    db.$queryRaw.mockReset();
    db.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0n }])
      .mockResolvedValueOnce([{ count: 0n }])
      .mockResolvedValueOnce([{ count: 0n }])
      .mockResolvedValueOnce([
        { model: "claude-opus-5", session_count: 2n },
        { model: "gpt-5.6", session_count: 1n },
      ])
      .mockResolvedValueOnce([{ total: 3n }])
      // ISS-9434: gauge 10's group-by, appended last.
      .mockResolvedValueOnce([]);

    const results = await auditDataInvariants();

    expect(results.unpricedTokenSessions.count).toBe(3);
    expect(results.unpricedTokenSessions.byModel).toEqual([
      { model: "claude-opus-5", sessionCount: 2 },
      { model: "gpt-5.6", sessionCount: 1 },
    ]);
    // A GAUGE: it must never page, so it stays out of the violation total even
    // when non-zero.
    expect(results.totalViolations).toBe(0);
    expect(mockEmitUnpricedTokenSessions).toHaveBeenCalledWith(3, [
      { model: "claude-opus-5", sessionCount: 2 },
      { model: "gpt-5.6", sessionCount: 1 },
    ]);

    // Assert the SQL TEXT, for the same reason the check-2 case above does: the
    // mock returns the queued rows already sorted and already short, so the
    // mapping assertions above pass with the LIMIT and the tie-break deleted.
    //
    // These are the Datadog label-cardinality control over a PRODUCER-SUPPLIED,
    // open model set — docs/data-invariants.md states them as the control, so
    // they need a test that fails when they go. DISTINCT belongs to the same
    // contract: without it a multi-model session is counted once per model.
    const byModelSql = JSON.stringify(db.$queryRaw.mock.calls[4]);
    expect(byModelSql).toContain("COUNT(DISTINCT sd.artifact_id)");
    expect(byModelSql).toContain("ORDER BY session_count DESC, tu.model ASC");
    expect(byModelSql).toContain("LIMIT");
  });

  it("emits gauge 9 even when the population is EMPTY", async () => {
    // The contract is "always emitted, including 0". Without this case a future
    // early-return on an empty result ships green and the Datadog monitor goes
    // no-data — which reads as "healthy" rather than "the cron stopped".
    await auditDataInvariants();

    expect(mockEmitUnpricedTokenSessions).toHaveBeenCalledWith(0, []);
  });

  it("sums totalViolations over exactly the violation checks", async () => {
    db.sessionDetail.count.mockResolvedValueOnce(1).mockResolvedValueOnce(7);
    // Reset before queueing: `makeDb` already primed four values, so chaining
    // would append behind them and this case would silently measure those.
    db.$queryRaw.mockReset();
    db.$queryRaw
      .mockResolvedValueOnce([{ branch_artifact_id: "b1", session_count: 1n }])
      .mockResolvedValueOnce([{ count: 0n }])
      .mockResolvedValueOnce([{ count: 0n }])
      .mockResolvedValueOnce([{ count: 0n }])
      // ISS-8515: gauge 9's two raw queries, then ISS-9434's gauge 10 group-by,
      // appended last so the ordered chain still lines up after this case
      // re-primes it.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }])
      .mockResolvedValueOnce([]);
    db.pullRequestDetail.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(0);

    const results = await auditDataInvariants();

    expect(results.zeroCostSessions.count).toBe(1);
    expect(results.zeroCostBranches.count).toBe(1);
    expect(results.unbranchedPrs.count).toBe(2);
    expect(results.linesFilesMismatch.count).toBe(3);
    expect(results.zeroEstimateWithReportedCost.count).toBe(7);
    expect(results.totalViolations).toBe(1 + 1 + 2 + 3 + 7);
  });

  it("keeps every gauge out of totalViolations", async () => {
    db.$queryRaw.mockReset();
    db.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 15n }])
      .mockResolvedValueOnce([{ count: 9n }])
      .mockResolvedValueOnce([{ count: 200n }])
      // ISS-8515: gauge 9's two raw queries, then ISS-9434's gauge 10 group-by,
      // appended last so the ordered chain still lines up after this case
      // re-primes it.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }])
      .mockResolvedValueOnce([]);
    db.pullRequestDetail.count.mockReset();
    db.pullRequestDetail.findMany.mockReset();
    db.pullRequestDetail.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(50);
    db.pullRequestDetail.findMany.mockResolvedValue([]);

    const results = await auditDataInvariants();

    expect(results.dualLedgerBranches).toBe(15);
    expect(results.costEstimateDivergence).toBe(9);
    expect(results.enrichmentPendingSessions).toBe(200);
    expect(results.enrichmentPendingPrs).toBe(50);
    expect(results.totalViolations).toBe(0);
  });
});

describe("formatViolationCounts", () => {
  it("names every violation check, and only those", async () => {
    const db = makeDb();
    mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));

    const rendered = formatViolationCounts(await auditDataInvariants());

    for (const key of VIOLATION_CHECK_KEYS) {
      expect(rendered).toContain(`${key}=`);
    }
    // The gauges must never appear: a non-zero gauge is normal operation, and
    // naming one in the alert text is how the channel learns to ignore it.
    expect(rendered).not.toContain("dualLedgerBranches");
    expect(rendered).not.toContain("costEstimateDivergence");
    expect(rendered).not.toContain("enrichmentPending");
  });
});

/**
 * ISS-7781 gauge 11, re-pointed by ISS-11096: the rows with no access-token
 * ciphertext, which fail every read closed now that the plaintext columns are
 * dropped. Gauge 12 (`plaintext_retained`) is retired.
 */
describe("auditDataInvariants — integration token encryption backlog", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    mockWithDb.mockImplementation((fn: (db: unknown) => unknown) => fn(db));
  });

  it("counts rows with no access-token ciphertext, per owner", async () => {
    // Distinct values per owner, so a swapped owner cannot pass.
    db.googleIntegration.count.mockResolvedValueOnce(7);
    db.linearIntegration.count.mockResolvedValueOnce(2);

    const results = await auditDataInvariants();

    expect(results.integrationTokenEncryption).toEqual({
      unencrypted: 9,
      byOwner: [
        { owner: IntegrationTokenOwner.Google, unencrypted: 7 },
        { owner: IntegrationTokenOwner.Linear, unencrypted: 2 },
      ],
    });
    expect(mockEmitIntegrationTokensUnencrypted).toHaveBeenCalledWith(9, [
      { owner: IntegrationTokenOwner.Google, unencrypted: 7 },
      { owner: IntegrationTokenOwner.Linear, unencrypted: 2 },
    ]);
  });

  /**
   * The predicate is the whole contract: keyed on a missing ciphertext alone,
   * so a row whose only credential is legacy plaintext is counted. Missing is
   * NULL or "", as the resolver reads it.
   */
  it("keys each table's count on a missing access-token ciphertext only", async () => {
    await auditDataInvariants();

    const where = {
      OR: [{ accessTokenEncrypted: null }, { accessTokenEncrypted: "" }],
    };
    expect(db.googleIntegration.count).toHaveBeenCalledTimes(1);
    expect(db.linearIntegration.count).toHaveBeenCalledTimes(1);
    expect(db.googleIntegration.count).toHaveBeenCalledWith({ where });
    expect(db.linearIntegration.count).toHaveBeenCalledWith({ where });
  });

  /**
   * Always emitted, including 0 — otherwise a stopped cron and a healthy table
   * look identical to the monitor.
   */
  it("emits the gauge when the backlog is empty", async () => {
    await auditDataInvariants();

    expect(mockEmitIntegrationTokensUnencrypted).toHaveBeenCalledWith(0, [
      { owner: IntegrationTokenOwner.Google, unencrypted: 0 },
      { owner: IntegrationTokenOwner.Linear, unencrypted: 0 },
    ]);
  });

  /**
   * A GAUGE, not a violation: adding the key to VIOLATION_CHECK_KEYS reddens
   * this line.
   */
  it("does not page: the backlog is a gauge, not a violation", async () => {
    db.googleIntegration.count.mockResolvedValueOnce(7);

    const results = await auditDataInvariants();

    expect(results.totalViolations).toBe(0);
    expect(VIOLATION_CHECK_KEYS).not.toContain("integrationTokenEncryption");
  });
});

const ERROR_ENDED_EXCLUSION_SQL = "ends_with_error IS NOT TRUE";

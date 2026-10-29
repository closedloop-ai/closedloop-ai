import {
  METERED_BILLING_MODES,
  SUBSCRIPTION_BILLING_MODES,
} from "@repo/api/src/types/billing-mode";
import { Prisma, withDb } from "@repo/database";
import {
  SESSION_PRICEABLE_SIGNALS,
  SESSION_PRICEABLE_WHERE,
  SESSION_TOKEN_USAGE_SIGNALS,
  SESSION_TOKEN_USAGE_WHERE,
  SessionSubstantiveAlias,
  sessionSubstantiveSql,
} from "@/app/agent-sessions/service/session-substantive-predicate";
import {
  emitCostEstimateDivergence,
  emitCrossOrgProjectAssignees,
  emitDualLedgerBranches,
  emitEnrichmentPendingPrs,
  emitEnrichmentPendingSessions,
  emitIntegrationTokensUnencrypted,
  emitLinesFilesMismatch,
  emitOffVocabularyArtifactStatuses,
  emitUnbranchedPrs,
  emitUnpricedTokenSessions,
  emitZeroCostBranches,
  emitZeroCostSessions,
  emitZeroEstimateWithReportedCost,
} from "@/lib/observability/data-invariant-metrics";
import {
  linesFilesContradictionWhere,
  unbranchedPullRequestWhere,
  unenrichedPullRequestWhere,
} from "@/lib/pull-request-invariant-audit-population";
import {
  checkOffVocabularyArtifactStatuses,
  type OffVocabularyArtifactStatuses,
} from "./artifact-status-conformance";
import { checkCrossOrgProjectAssignees } from "./cross-org-project-assignees";
import {
  checkIntegrationTokenEncryption,
  type IntegrationTokenEncryptionBacklog,
} from "./integration-token-encryption";

const MAX_SAMPLE_IDS = 10;

/**
 * ISS-8515: "this session has no cost" — a stored `0` OR a stored `NULL`.
 *
 * NULL became reachable when the ingest stopped fabricating `$0` for a session
 * nothing ever priced, so a `= 0` predicate silently stopped seeing the very rows
 * these checks exist to catch. In SQL `NULL = 0` is NULL, not TRUE, which is the
 * same three-valued-logic trap `SESSION_COST_UNKNOWN_WHERE`
 * (`query-builder.ts:510`) already documents by name.
 *
 * Deliberately NOT composed from that constant: it is the SQL twin of the Sessions
 * UI "Unknown cost" FILTER and carries `billingMode` disjuncts this audit already
 * expresses through `METERED_BILLING_MODES`, and it uses `lte: 0`, which would
 * newly admit negative costs and widen these populations past what ISS-8515 ruled.
 *
 * Two dialects of one rule, kept adjacent so they cannot drift — the same shape
 * `session-substantive-predicate.ts` uses for `SESSION_PRICEABLE_WHERE` and
 * `sessionSubstantiveSql`.
 */
const ZERO_OR_UNKNOWN_COST_WHERE: Prisma.SessionDetailWhereInput = {
  OR: [
    { estimatedCost: null },
    { estimatedCost: { equals: new Prisma.Decimal(0) } },
  ],
};

/** The raw-SQL dialect of {@link ZERO_OR_UNKNOWN_COST_WHERE}. */
function zeroOrUnknownCostSql(alias: string): Prisma.Sql {
  return Prisma.sql`(${Prisma.raw(alias)}.estimated_cost = 0 OR ${Prisma.raw(alias)}.estimated_cost IS NULL)`;
}

const COST_DIVERGENCE_RATIO = 0.5;

export type InvariantCheckResult = {
  count: number;
  sampleIds: string[];
};

/**
 * ISS-8515 gauge 9's shape. Every other gauge in {@link AuditResults} is a plain
 * `number`; this one carries a bounded per-model breakdown, so it is a NEW shape
 * rather than "the checks 6-8 pattern" in the type sense. It follows those checks
 * in the way that matters — non-paging, absent from `VIOLATION_CHECK_KEYS`.
 */
export type UnpricedTokenSessions = {
  count: number;
  byModel: Array<{ model: string; sessionCount: number }>;
};

export type AuditResults = {
  zeroCostSessions: InvariantCheckResult;
  zeroCostBranches: InvariantCheckResult;
  unbranchedPrs: InvariantCheckResult;
  linesFilesMismatch: InvariantCheckResult;
  zeroEstimateWithReportedCost: InvariantCheckResult;
  crossOrgProjectAssignees: InvariantCheckResult;
  dualLedgerBranches: number;
  costEstimateDivergence: number;
  enrichmentPendingSessions: number;
  enrichmentPendingPrs: number;
  unpricedTokenSessions: UnpricedTokenSessions;
  offVocabularyArtifactStatuses: OffVocabularyArtifactStatuses;
  integrationTokenEncryption: IntegrationTokenEncryptionBacklog;
  totalViolations: number;
};

/**
 * The checks that count as VIOLATIONS: they sum into `totalViolations` and
 * name themselves in the Slack alert. The gauges (`dualLedgerBranches`,
 * `costEstimateDivergence`, the two enrichment-pending counts, ISS-8515's
 * `unpricedTokenSessions`, and ISS-9434's `offVocabularyArtifactStatuses`) are deliberately absent — a non-zero gauge is normal operation, so paging on one would train
 * the channel to ignore this alert.
 *
 * ISS-9434's is the one whose name argues for membership and does not get it.
 * It reports rows that violate a vocabulary, but PLN-1978 §6 records its census
 * as covering ONE org, and migration `20260817120000` deliberately left a live
 * `waiting` session population in place — so its steady state is unmeasured and
 * plausibly non-zero every day. Paging on that is the noise this list exists to
 * keep out.
 *
 * Both the sum and the alert text derive from this one list, so a violation
 * check added to `AuditResults` cannot reach production counted-but-unnamed or
 * named-but-uncounted.
 */
export const VIOLATION_CHECK_KEYS = [
  "zeroCostSessions",
  "zeroCostBranches",
  "unbranchedPrs",
  "linesFilesMismatch",
  "zeroEstimateWithReportedCost",
  "crossOrgProjectAssignees",
] as const;

export type ViolationCheckKey = (typeof VIOLATION_CHECK_KEYS)[number];

/** Renders `key=count` for every violation check, in inventory order. */
export function formatViolationCounts(results: AuditResults): string {
  return VIOLATION_CHECK_KEYS.map((key) => `${key}=${results[key].count}`).join(
    " "
  );
}

const meteredModes = [...METERED_BILLING_MODES];
const subscriptionModes = [...SUBSCRIPTION_BILLING_MODES];

export async function auditDataInvariants(): Promise<AuditResults> {
  const zeroCostSessions = await checkZeroCostMeteredSessions();
  const zeroCostBranches = await checkZeroCostMeteredBranches();
  const unbranchedPrs = await checkUnbranchedPrs();
  const linesFilesMismatch = await checkLinesFilesMismatch();
  const zeroEstimateWithReportedCost =
    await checkZeroEstimateWithReportedCost();
  const dualLedgerBranches = await checkDualLedgerBranches();
  const costEstimateDivergence = await checkCostEstimateDivergence();
  const enrichmentPendingSessions = await checkEnrichmentPendingSessions();
  const enrichmentPendingPrs = await checkEnrichmentPendingPrs();
  const unpricedTokenSessions = await checkUnpricedTokenBearingSessions();
  const offVocabularyArtifactStatuses =
    await checkOffVocabularyArtifactStatuses();
  const integrationTokenEncryption = await checkIntegrationTokenEncryption();
  const crossOrgProjectAssignees =
    await checkCrossOrgProjectAssignees(MAX_SAMPLE_IDS);

  emitZeroCostSessions(zeroCostSessions.count, zeroCostSessions.sampleIds);
  emitZeroCostBranches(zeroCostBranches.count, zeroCostBranches.sampleIds);
  emitUnbranchedPrs(unbranchedPrs.count, unbranchedPrs.sampleIds);
  emitLinesFilesMismatch(
    linesFilesMismatch.count,
    linesFilesMismatch.sampleIds
  );
  emitZeroEstimateWithReportedCost(
    zeroEstimateWithReportedCost.count,
    zeroEstimateWithReportedCost.sampleIds
  );
  emitDualLedgerBranches(dualLedgerBranches);
  emitCostEstimateDivergence(costEstimateDivergence);
  emitEnrichmentPendingSessions(enrichmentPendingSessions);
  emitEnrichmentPendingPrs(enrichmentPendingPrs);
  emitUnpricedTokenSessions(
    unpricedTokenSessions.count,
    unpricedTokenSessions.byModel
  );
  emitOffVocabularyArtifactStatuses(
    offVocabularyArtifactStatuses.count,
    offVocabularyArtifactStatuses.byStatus
  );
  emitIntegrationTokensUnencrypted(
    integrationTokenEncryption.unencrypted,
    integrationTokenEncryption.byOwner
  );
  emitCrossOrgProjectAssignees(
    crossOrgProjectAssignees.count,
    crossOrgProjectAssignees.sampleIds
  );

  const checks = {
    zeroCostSessions,
    zeroCostBranches,
    unbranchedPrs,
    linesFilesMismatch,
    zeroEstimateWithReportedCost,
    dualLedgerBranches,
    costEstimateDivergence,
    enrichmentPendingSessions,
    enrichmentPendingPrs,
    unpricedTokenSessions,
    offVocabularyArtifactStatuses,
    integrationTokenEncryption,
    crossOrgProjectAssignees,
  };

  return {
    ...checks,
    totalViolations: VIOLATION_CHECK_KEYS.reduce(
      (total, key) => total + checks[key].count,
      0
    ),
  };
}

/**
 * Exported (ISS-10833) so an integration test can exercise this single check
 * against a real database without paying for `auditDataInvariants()`'s other
 * 12 checks inside the same transaction.
 */
export function checkZeroCostMeteredSessions(): Promise<InvariantCheckResult> {
  return withDb(async (db) => {
    // AND, never a spread: the substantive predicate owns the `OR` key, so
    // spreading it here would clobber (or be clobbered by) any sibling `OR`
    // this filter grows later.
    const where: Prisma.SessionDetailWhereInput = {
      billingMode: { in: meteredModes },
      // ISS-5801: the PRICEABLE subset, not the full substantive set — an
      // invocation-only session is substantive but consumed no tokens, so its
      // $0 metered cost is correct, not a violation.
      //
      // ISS-8515: the cost predicate is an ELEMENT of this array, and the former
      // top-level `estimatedCost` key is GONE rather than left beside it. Prisma
      // implicitly ANDs every top-level key with `AND`, so keeping both would give
      // `estimatedCost = 0 AND (estimatedCost = 0 OR IS NULL)` — which collapses
      // straight back to `= 0` and makes the widening silently inert.
      //
      // APPENDED, never prepended: the priceable predicate must stay at `AND[0]`.
      AND: [
        SESSION_PRICEABLE_WHERE,
        ZERO_OR_UNKNOWN_COST_WHERE,
        NOT_ERROR_ENDED_WITHOUT_USAGE_WHERE,
      ],
    };

    const [count, samples] = await Promise.all([
      db.sessionDetail.count({ where }),
      db.sessionDetail.findMany({
        where,
        select: { artifactId: true },
        take: MAX_SAMPLE_IDS,
      }),
    ]);

    return {
      count,
      sampleIds: samples.map((s) => s.artifactId),
    };
  });
}

function checkZeroCostMeteredBranches(): Promise<InvariantCheckResult> {
  const alias = SessionSubstantiveAlias.SessionDetail;
  // ONE clause for the sample page and the exact-count fallback, so the two
  // cannot drift apart (ISS-12142).
  const where = Prisma.sql`
    WHERE al.link_type = 'RELATES_TO'
      AND sd.billing_mode IN (${Prisma.join(meteredModes)})
      AND ${zeroOrUnknownCostSql("sd")}
      AND ${sessionSubstantiveSql(
        alias,
        // ISS-5801: priceable subset — see checkZeroCostMeteredSessions.
        SESSION_PRICEABLE_SIGNALS
      )}
      AND ${notErrorEndedWithoutUsageSql(alias)}
  `;

  return withDb(async (db) => {
    const rows = await db.$queryRaw<
      Array<{ branch_artifact_id: string; session_count: bigint }>
    >`
      SELECT al.target_id AS branch_artifact_id, COUNT(*) AS session_count
      FROM session_detail sd
      JOIN artifact_links al ON al.source_id = sd.artifact_id
      JOIN artifacts a ON a.id = al.target_id AND a.type = 'BRANCH'
      ${where}
      GROUP BY al.target_id
      LIMIT ${MAX_SAMPLE_IDS}
    `;

    const sampleIds = rows.map((r) => r.branch_artifact_id);

    let count = sampleIds.length;
    if (count === MAX_SAMPLE_IDS) {
      const [{ total }] = await db.$queryRaw<Array<{ total: bigint }>>`
        SELECT COUNT(DISTINCT al.target_id) AS total
        FROM session_detail sd
        JOIN artifact_links al ON al.source_id = sd.artifact_id
        JOIN artifacts a ON a.id = al.target_id AND a.type = 'BRANCH'
        ${where}
      `;
      count = Number(total);
    }

    return { count, sampleIds };
  });
}

function checkUnbranchedPrs(): Promise<InvariantCheckResult> {
  return withDb(async (db) => {
    const where = unbranchedPullRequestWhere();

    const [count, samples] = await Promise.all([
      db.pullRequestDetail.count({ where }),
      db.pullRequestDetail.findMany({
        where,
        select: { id: true },
        take: MAX_SAMPLE_IDS,
      }),
    ]);

    return {
      count,
      sampleIds: samples.map((s) => s.id),
    };
  });
}

function checkLinesFilesMismatch(): Promise<InvariantCheckResult> {
  return withDb(async (db) => {
    const where = linesFilesContradictionWhere();

    const [count, samples] = await Promise.all([
      db.pullRequestDetail.count({ where }),
      db.pullRequestDetail.findMany({
        where,
        select: { id: true },
        take: MAX_SAMPLE_IDS,
      }),
    ]);

    return {
      count,
      sampleIds: samples.map((s) => s.id),
    };
  });
}

/**
 * ISS-4752's "no cost with zero estimated cost where impossible": Claude
 * reported real spend for the session, and our own estimator produced $0.
 *
 * `authoritativeCostUsd` is nullable with no default and a stored `0` is a
 * REPORTED zero — a real measurement — so this admits only rows above zero.
 * A null (the majority: the `result` envelope exists only for harness stdout
 * captures) is "Claude reported no cost" and says nothing about the estimate.
 */
function checkZeroEstimateWithReportedCost(): Promise<InvariantCheckResult> {
  return withDb(async (db) => {
    // ISS-8515: widened to `= 0 OR IS NULL`, and the old top-level `estimatedCost`
    // key is REPLACED rather than joined. Claude reported real spend while our own
    // estimator produced nothing is at least as much a violation as it producing
    // $0 — and left at `= 0` this row would match NEITHER this check nor check 7
    // (which requires `estimated_cost > 0`), so a paging violation would have gone
    // quiet exactly as the null population grew. `docs/data-invariants.md` records
    // check 7 handing these rows TO this check, and that handoff is what breaks.
    //
    // Composed into `AND`, never spread — the same rule check 1 states above and
    // for the same reason. The fragment owns the top-level `OR` key, so spreading
    // it makes any sibling `OR` this filter later grows clobber half the
    // predicate silently. Identical behaviour today; the difference is only
    // whether the next edit can break it quietly.
    const where: Prisma.SessionDetailWhereInput = {
      authoritativeCostUsd: { gt: new Prisma.Decimal(0) },
      AND: [ZERO_OR_UNKNOWN_COST_WHERE],
    };

    const [count, samples] = await Promise.all([
      db.sessionDetail.count({ where }),
      db.sessionDetail.findMany({
        where,
        select: { artifactId: true },
        take: MAX_SAMPLE_IDS,
      }),
    ]);

    return {
      count,
      sampleIds: samples.map((s) => s.artifactId),
    };
  });
}

function checkDualLedgerBranches(): Promise<number> {
  return withDb(async (db) => {
    const [{ count }] = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM (
        SELECT al.target_id
        FROM session_detail sd
        JOIN artifact_links al ON al.source_id = sd.artifact_id
        JOIN artifacts a ON a.id = al.target_id AND a.type = 'BRANCH'
        WHERE al.link_type = 'RELATES_TO'
          AND sd.billing_mode IS NOT NULL
        GROUP BY al.target_id
        HAVING
          COUNT(*) FILTER (WHERE sd.billing_mode IN (${Prisma.join(subscriptionModes)})) > 0
          AND COUNT(*) FILTER (WHERE sd.billing_mode IN (${Prisma.join(meteredModes)})) > 0
      ) AS dual
    `;
    return Number(count);
  });
}

/**
 * Estimator drift where BOTH operands are real measurements — the
 * `estimated_cost - authoritative_cost_usd` delta the `authoritativeCostUsd`
 * column exists to make queryable in SQL.
 *
 * A GAUGE, not a violation: the two values come from different producers with
 * different pricing engines, so they are never expected to agree exactly and a
 * non-zero count is normal. Only the trend is actionable. Rows where the
 * estimate is $0 are excluded here and counted as the violation above instead,
 * so a row is never reported by both.
 */
function checkCostEstimateDivergence(): Promise<number> {
  return withDb(async (db) => {
    const [{ count }] = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM session_detail sd
      WHERE sd.authoritative_cost_usd IS NOT NULL
        AND sd.authoritative_cost_usd > 0
        AND sd.estimated_cost IS NOT NULL
        AND sd.estimated_cost > 0
        AND ABS(sd.estimated_cost - sd.authoritative_cost_usd)
              / sd.authoritative_cost_usd > ${COST_DIVERGENCE_RATIO}
    `;
    return Number(count);
  });
}

function checkEnrichmentPendingSessions(): Promise<number> {
  return withDb(async (db) => {
    const [{ count }] = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM session_detail sd
      JOIN artifacts a ON a.id = sd.artifact_id AND a.type = 'SESSION'
      WHERE NOT EXISTS (
        SELECT 1 FROM artifact_links al
        JOIN artifacts target_a ON target_a.id = al.target_id AND target_a.type = 'BRANCH'
        WHERE al.source_id = sd.artifact_id
          AND al.link_type = 'RELATES_TO'
      )
    `;
    return Number(count);
  });
}

function checkEnrichmentPendingPrs(): Promise<number> {
  return withDb((db) =>
    db.pullRequestDetail.count({ where: unenrichedPullRequestWhere() })
  );
}

/**
 * ISS-8515 gauge 9: token-bearing sessions carrying NO cost, by model.
 *
 * A GAUGE, never a violation. The cloud has no priceability list — ISS-7361 is
 * approval-gated — so it cannot tell "our estimator has no price for this model"
 * from "this session genuinely cost nothing", and paging on the difference would
 * train the channel to ignore the alert. It MAY overlap check 1, and unknown-model
 * rows are deliberately NOT carved out of that check.
 *
 * Keys on the PARENT `estimated_cost IS NULL`. The per-model
 * `agent_session_token_usage.estimated_cost` cannot serve: it is `NOT NULL
 * DEFAULT 0` and the ingest coerces a missing per-row cost to `roundCost(… ?? 0)`,
 * so a per-model zero cannot tell "free" from "never priced".
 *
 * "Token-bearing" means a per-model row EXISTS, not that its counts are positive —
 * an all-zero row still names a model the session used, and requiring positive
 * counts would drop the unpriceable-model case this gauge exists to surface.
 *
 * The breakdown is bounded by MAX_SAMPLE_IDS with a `model ASC` tie-break: the
 * model set is producer-supplied and open, which is a real Datadog label-cardinality
 * hazard. The total is counted separately and DISTINCT, so a multi-model session
 * counts once there while appearing under each of its models in the breakdown.
 */
function checkUnpricedTokenBearingSessions(): Promise<UnpricedTokenSessions> {
  return withDb(async (db) => {
    const [byModelRows, [{ total }]] = await Promise.all([
      db.$queryRaw<Array<{ model: string; session_count: bigint }>>`
        SELECT tu.model AS model, COUNT(DISTINCT sd.artifact_id) AS session_count
        FROM session_detail sd
        JOIN agent_session_token_usage tu ON tu.agent_session_id = sd.artifact_id
        WHERE sd.estimated_cost IS NULL
        GROUP BY tu.model
        ORDER BY session_count DESC, tu.model ASC
        LIMIT ${MAX_SAMPLE_IDS}
      `,
      db.$queryRaw<Array<{ total: bigint }>>`
        SELECT COUNT(*) AS total
        FROM session_detail sd
        WHERE sd.estimated_cost IS NULL
          AND EXISTS (
            SELECT 1 FROM agent_session_token_usage tu
            WHERE tu.agent_session_id = sd.artifact_id
          )
      `,
    ]);

    return {
      count: Number(total),
      byModel: byModelRows.map((row) => ({
        model: row.model,
        sessionCount: Number(row.session_count),
      })),
    };
  });
}

/**
 * ISS-10833, Perrin Upcott's 2026-10-06 ruling "Exclude error-ended ones":
 * "Sessions that ended on a recorded provider error (rate limit, unsupported
 * model) stop paging. The rest keep paging, so a collector regression that
 * drops tokens still pages."
 *
 * "Ended on a recorded provider error" is `endsWithError`, the desktop's
 * unrecovered-API-error verdict. The exclusion needs it TRUE and no token
 * recorded, so a session that recorded tokens and still has no cost pages.
 *
 * Spelled as the positive complement rather than `NOT { endsWithError: true,
 * … }`: a NULL flag (pre-ISS-4586 rows, older desktop builds) makes that `NOT`
 * evaluate to SQL NULL, which would drop the row from the count.
 */
const NOT_ERROR_ENDED_WITHOUT_USAGE_WHERE: Prisma.SessionDetailWhereInput = {
  OR: [
    { endsWithError: null },
    { endsWithError: false },
    SESSION_TOKEN_USAGE_WHERE,
  ],
};

/**
 * The raw-SQL dialect of {@link NOT_ERROR_ENDED_WITHOUT_USAGE_WHERE}, for the
 * branch check (ISS-12142, the same ruling: "Yes, keep them consistent").
 * `IS NOT TRUE` is the NULL-safe spelling of the `null` and `false` arms.
 */
function notErrorEndedWithoutUsageSql(
  alias: SessionSubstantiveAlias
): Prisma.Sql {
  return Prisma.sql`(${Prisma.raw(alias)}.ends_with_error IS NOT TRUE OR ${sessionSubstantiveSql(alias, SESSION_TOKEN_USAGE_SIGNALS)})`;
}

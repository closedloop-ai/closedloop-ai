/**
 * Agents-section spend helpers for the Insights surface.
 *
 * Split out of `service.ts` (ISS-4463) so the agents-section spend/token
 * shaping lives in its own module rather than growing the composition root,
 * which is over the file-size ceiling and shrink-only. Every export here is a
 * pure shaper or a scope-parameterized query: the module takes an already-built
 * scope predicate rather than an `InsightsScopeContext`, so it never has to
 * import `service.ts` back (no import cycle) and org/team/me scoping stays owned
 * by the one `sessionScopeSql` helper in the composition root.
 */

import {
  SPEND_OUTCOME_LABELS_WITH_RUNNING,
  SPEND_OUTCOME_ORDER_WITH_RUNNING,
  SpendOutcome,
} from "@closedloop-ai/loops-api/insights";
import type { CategoryBucket } from "@repo/api/src/types/insights";
import { Prisma, withDb } from "@repo/database";

// DB-summed token columns for the KPI row + token-distribution donut, over the
// selected period. Replaces materializing every token row to reduce in JS.
export type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export function tokenDistributionBuckets(
  totals: TokenTotals
): CategoryBucket[] {
  return [
    { key: "input", label: "Input", value: totals.inputTokens },
    { key: "output", label: "Output", value: totals.outputTokens },
    { key: "cache-read", label: "Cache read", value: totals.cacheReadTokens },
    {
      key: "cache-write",
      label: "Cache write",
      value: totals.cacheWriteTokens,
    },
  ];
}

/**
 * One row of the fused spend scan. A model-grouping row carries `model` with
 * `outcome` NULL; an outcome-grouping row carries `outcome` with `model` NULL.
 * `field` disambiguates so neither grouping has to infer itself from NULLs.
 */
type SpendBreakdownRow = {
  field: "model" | "outcome";
  model: string | null;
  outcome: string | null;
  cost: number;
};

/** The two Agents-section spend visuals, read from one snapshot. */
export type AgentsSpendBreakdowns = {
  /** Spend (USD) by model, descending — drives the model KPI and top-N series. */
  modelBreakdown: CategoryBucket[];
  /** Spend (USD) by the originating session's lifecycle outcome. */
  spendByOutcome: CategoryBucket[];
};

/**
 * Both Agents-section spend breakdowns — by model and by session outcome — in
 * ONE statement (ISS-4463).
 *
 * ONE STATEMENT IS THE POINT (wongk, PR #4282). Two separate `withDb` reads are
 * two separate implicit transactions: a session sync can replace token-usage
 * rows after the model read and before the outcome read, and the two charts then
 * disagree inside a single response while sitting side by side in the same
 * section. A single statement sees one MVCC snapshot by construction, so the
 * pair cannot skew — without paying for an explicit repeatable-read transaction.
 *
 * Fusing also means the outcome split adds NO independent failure mode and no
 * extra round-trip: it is one more GROUPING SET over a scan the Agents response
 * already required for "Spend by model", not a new optional aggregate that could
 * time out on its own and blank every other Agents widget.
 *
 * The `GROUPING SETS ((model), (outcome))` shape mirrors the agent status/type
 * rollup in `service.ts` — each grouping is rolled up independently in a single
 * pass, and `GROUPING()` tags which one a row belongs to.
 *
 * The outcome split is deliberately the FACTUAL half of the TokenOps story, not
 * a heuristic one: it keys on values the collector either observed or did not.
 * No "recoverable waste" multiplier, model right-sizing verdict, or context-bloat
 * score is inferred here — those are product judgments, out of scope for this
 * slice.
 */
export async function fetchAgentsSpendBreakdowns(
  scopeSql: Prisma.Sql,
  start: Date,
  end: Date
): Promise<AgentsSpendBreakdowns> {
  const rows = await withDb((db) =>
    db.$queryRaw<SpendBreakdownRow[]>(
      Prisma.sql`
        SELECT
          CASE WHEN GROUPING(model) = 0 THEN 'model' ELSE 'outcome' END AS field,
          model,
          outcome,
          SUM(cost)::float8 AS cost
        FROM (
          SELECT
            tu.model AS model,
            -- Terminality and verdict are independent facts. ends_with_error
            -- carries only the verdict and is stamped non-null on ACTIVE rows
            -- too, so a live session's false must NOT be read as "ended clean".
            -- session_ended_at IS NULL is this surface's existing definition of
            -- an open session (the runtime rollup treats the same rows as
            -- contributing zero elapsed time).
            CASE
              WHEN s.session_ended_at IS NULL THEN ${SpendOutcome.Running}
              WHEN s.ends_with_error IS TRUE THEN ${SpendOutcome.Errored}
              WHEN s.ends_with_error IS FALSE THEN ${SpendOutcome.Clean}
              ELSE ${SpendOutcome.Unknown}
            END AS outcome,
            tu.estimated_cost AS cost
          FROM agent_session_token_usage tu
          JOIN session_detail s ON s.artifact_id = tu.agent_session_id
          JOIN artifacts a ON a.id = s.artifact_id
          WHERE s.session_started_at >= ${start}
            AND s.session_started_at <= ${end}
            AND (${scopeSql})
        ) scoped
        GROUP BY GROUPING SETS ((model), (outcome))
      `
    )
  );

  return {
    modelBreakdown: modelBucketsFrom(rows),
    spendByOutcome: outcomeBucketsFrom(rows),
  };
}

/**
 * Spend (USD) by model, descending. FEA-2331 ranks models by estimated spend,
 * not raw tokens; the distinct-model KPI is this array's length. Each model is
 * rounded to cents independently, exactly as the prior `groupBy` read did — this
 * chart's per-model values are unchanged by the ISS-4463 fusion.
 */
function modelBucketsFrom(rows: SpendBreakdownRow[]): CategoryBucket[] {
  return rows
    .filter((row) => row.field === "model" && row.model !== null)
    .map((row) => ({
      key: row.model ?? "",
      label: row.model ?? "",
      value: roundCents(Number(row.cost ?? 0)),
    }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Spend (USD) by session outcome, in the shared {@link SPEND_OUTCOME_ORDER_WITH_RUNNING}.
 *
 * All four buckets are always emitted — an absent outcome is a measured zero for
 * the period, not an omission — and they are allocated to cents against the
 * period's exact total, so the parts SUM EXACTLY TO THE WHOLE. Rounding each
 * bucket independently would not conserve the total (three halves-of-a-cent
 * round up to more money than was spent), and this tile's whole job is to answer
 * "what share of spend burned on sessions that errored".
 *
 * NOTE the reconciliation this does and does NOT claim (wongk / codex, #4282).
 * These buckets share a cost basis with "Spend by model" — same rows, window and
 * scope predicate, same statement — so both describe the same dollars. But that
 * chart rounds each of its N models independently (pre-existing behaviour this
 * change deliberately does not alter), so ITS displayed values can sum a cent or
 * two away from this total. The buckets conserve the true total; the copy says
 * that and no more.
 */
function outcomeBucketsFrom(rows: SpendBreakdownRow[]): CategoryBucket[] {
  const totals = new Map<SpendOutcome, number>(
    SPEND_OUTCOME_ORDER_WITH_RUNNING.map((outcome) => [outcome, 0])
  );
  for (const row of rows) {
    if (row.field !== "outcome") {
      continue;
    }
    const outcome = asSpendOutcome(row.outcome);
    totals.set(outcome, (totals.get(outcome) ?? 0) + Number(row.cost ?? 0));
  }

  const exact = SPEND_OUTCOME_ORDER_WITH_RUNNING.map(
    (outcome) => totals.get(outcome) ?? 0
  );
  const allocated = allocateCents(
    exact,
    exact.reduce((sum, value) => sum + value, 0)
  );
  return SPEND_OUTCOME_ORDER_WITH_RUNNING.map((outcome, index) => ({
    key: outcome,
    label: SPEND_OUTCOME_LABELS_WITH_RUNNING[outcome],
    value: allocated[index] ?? 0,
  }));
}

const CENTS_SCALE = 100;

/**
 * Narrow the SQL-side outcome literal back to the shared union. The CASE only
 * ever emits a {@link SpendOutcome} member, but this crosses a raw-query
 * boundary where the row type is asserted rather than proven, so an unrecognised
 * value degrades to `Unknown` instead of silently minting a bucket key no
 * consumer has a label or colour for.
 */
function asSpendOutcome(value: string | null): SpendOutcome {
  const match = SPEND_OUTCOME_ORDER_WITH_RUNNING.find(
    (outcome) => outcome === value
  );
  return match ?? SpendOutcome.Unknown;
}

/**
 * Largest-remainder allocation of `targetTotal` across `values`, in cents.
 *
 * Every part is floored to a cent, then the leftover cents are handed out to the
 * parts with the biggest discarded remainders. The result therefore sums to the
 * rounded total EXACTLY, which independent per-part rounding cannot promise.
 *
 * Mirrors the desktop collector's `allocateRoundedUsdValues` (the golden-derive
 * oracle) rather than importing it — that helper lives in `apps/desktop`'s test
 * tree and is not reachable from the API package.
 */
function allocateCents(values: number[], targetTotal: number): number[] {
  const floors = values.map((value) => Math.floor(value * CENTS_SCALE));
  const targetCents = Math.round(targetTotal * CENTS_SCALE);
  let leftover = targetCents - floors.reduce((sum, cents) => sum + cents, 0);

  // Biggest discarded fraction first; ties break on the original order so the
  // allocation is deterministic across refreshes.
  const order = values
    .map((value, index) => ({
      index,
      remainder: value * CENTS_SCALE - floors[index],
    }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const cents = [...floors];
  for (const { index } of order) {
    if (leftover <= 0) {
      break;
    }
    cents[index] += 1;
    leftover -= 1;
  }
  return cents.map((value) => value / CENTS_SCALE);
}

function roundCents(value: number): number {
  return Math.round(value * CENTS_SCALE) / CENTS_SCALE;
}

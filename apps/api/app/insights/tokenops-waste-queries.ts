import { Prisma, withDb } from "@repo/database";
import {
  assertGroupSafe,
  PRODUCED_ARTIFACT,
  sessionWindow,
  WALL_CLOCK_MINUTES,
} from "./session-analytics-sql";

/**
 * The database reads behind the TokenOps waste-vs-leverage screen (ISS-4988).
 *
 * Spend is read from the PERSISTED `agent_session_token_usage.estimated_cost`
 * column, which the canonical cost engine (`genai-cost.ts`) priced at write
 * time. Recomputing pricing here would create a second cost basis that drifts
 * from every other Insights chart, which is precisely the divergence this
 * screen exists to expose rather than to cause.
 *
 * The window column (`session_detail.session_started_at`) and the scope
 * predicate are the same ones the sibling session aggregates use, and the
 * outcome grid is driven from `session_detail` itself, so the outcome split
 * describes the same period over the same population as the Lost-work screen.
 * The MODEL right-sizing reads are necessarily narrower — a session with no
 * token-usage row has no model to attribute — and say so at their source.
 */

/**
 * The signal dimensions TokenOps classifies on. Bounded: 3 × 2 × 2 × states.
 *
 * `a.status` is grouped on because the shared classifier reads it: a run that
 * has not reached a terminal status has no outcome yet, and without it a live
 * session's `ends_with_error: false` would land its spend in the "Ended clean"
 * bucket. ISS-7019 moved this off `s.state`, a column nothing writes, which is
 * why that bucket HAS been absorbing live runs.
 *
 * This is interpolated into both {@link SPEND_GRID_SELECT} and the `GROUP BY`
 * of every read below, so every fragment it carries must be parameter-free —
 * see the rule in `session-analytics-sql.ts` and ISS-5263.
 */
const SPEND_GRID_DIMENSIONS = assertGroupSafe(
  "SPEND_GRID_DIMENSIONS",
  Prisma.sql`
  s.ends_with_error,
  ${PRODUCED_ARTIFACT},
  (${WALL_CLOCK_MINUTES} > 0),
  a.status
`
);

/** The matching SELECT list. Must render byte-identically to the above. */
const SPEND_GRID_SELECT = assertGroupSafe(
  "SPEND_GRID_SELECT",
  Prisma.sql`
  s.ends_with_error AS "endsWithError",
  ${PRODUCED_ARTIFACT} AS "producedArtifact",
  (${WALL_CLOCK_MINUTES} > 0) AS "hasWallClock",
  a.status AS "status"
`
);

/**
 * The model right-sizing table grades on TWO bases, and they are deliberately
 * different columns (ISS-5189). Read them together — the split is the fix.
 *
 * The defect was that both Over-powered guards were computed over the same
 * all-four-column total, so both moved with a harness's prompt-cache REUSE
 * rather than with price or job size, and in the SAME direction: replay
 * inflated the rate's denominator AND the measured job size, so a cache-heavy
 * model showed a low $/Mtok AND large-looking sessions and was structurally
 * exempt from the verdict, while a low-cache model read as expensive on small
 * work. Claude Code replays the same prefix every turn, so nearly all of its
 * volume lands in `cache_read_tokens` — the hazard FEA-2331 already documents
 * on the desktop model charts (`local-insights.ts`).
 *
 * {@link BILLED_TOKEN_SUM} — every token the provider charged for — stays the
 * RATE denominator. `estimated_cost` is a single priced Decimal with no
 * per-class breakdown, so it is the only denominator whose population matches
 * that numerator. Dividing a bill that prices cache reads by a count that
 * excludes them is not a cache-neutral rate, it is an incoherent one: it would
 * report a model that reuses its cache heavily — and therefore costs LESS in
 * real dollars for the same work — as several times more expensive per million.
 * That is the original distortion with its sign flipped, not its removal.
 *
 * {@link WORK_TOKEN_SUM} — first-pass tokens only — is the JOB-SIZE proxy.
 * Re-reading one prefix ten times is one job, not ten, so replay is the one
 * class that must not count here. `cache_write_tokens` stays: per the input
 * convention in `packages/cost/src/genai-cost.ts`, `input_tokens` holds only
 * the UNCACHED remainder, and cache writes are fresh content being processed
 * for the first time, so dropping them would shrink real jobs.
 *
 * Together the two guards stop moving as one. Cache reuse now pushes the rate
 * DOWN (cheap tokens dilute the blend, which is a true economic fact) while
 * pushing measured job size DOWN as well — so it drives the guards in opposite
 * directions instead of aligning them, and neither caching behaviour nor its
 * absence can decide the verdict on its own.
 *
 * Two sibling per-model derivations read these columns and deliberately do NOT
 * match {@link WORK_TOKEN_SUM}. Neither is wrong; they answer different
 * questions, and the disagreement is stated here rather than left to be
 * discovered:
 * - `countedTokens` (`token-derivations.ts`) counts input + output for the
 *   "Input + output tokens" KPI, whose exact equality is pinned by the desktop
 *   golden oracle, so it cannot absorb cache writes.
 * - `fetchModelUsageRows` (`service.ts`, FEA-3497) sums all four for the Agents
 *   usage toggle, which asks how much total volume a model moved. Replay
 *   belongs in that answer and not in a job-size one.
 *
 * The screen names the job-size basis where that number is rendered, so a
 * reader is never left guessing which tokens they are looking at — see
 * `model-right-sizing.tsx`.
 *
 * The wire carries BOTH medians for one release, and that is deliberate rather
 * than transitional clutter. `apps/api` and `apps/app` are separate Vercel
 * deploy units on a single push to `main`, so one of them is old for a window
 * whichever lands first. Swapping this basis underneath the EXISTING
 * `medianTokens` key would make that window misreport in one direction or the
 * other: an old screen would caption first-pass numbers with the vague header
 * it used to carry, and a new screen would caption billed numbers with copy
 * that asserts they are first-pass — a confident false statement, which is the
 * worse half. So `medianTokens` keeps its billed basis untouched and
 * `medianWorkTokens` arrives beside it as an optional field. The new screen
 * reads only the new key and shows its unavailable dash when the key is absent,
 * so neither deploy order can put a number under copy that does not describe
 * it. `medianTokens` is retired in a later release, not this one.
 */
const BILLED_TOKEN_SUM = Prisma.sql`
  (
    tu.input_tokens + tu.output_tokens
    + tu.cache_read_tokens + tu.cache_write_tokens
  )
`;

/** First-pass tokens: everything except replayed cache reads. See above. */
const WORK_TOKEN_SUM = Prisma.sql`
  (tu.input_tokens + tu.output_tokens + tu.cache_write_tokens)
`;

/**
 * The OUTCOME population: every session the Lost-work screen describes, whether
 * or not it ever recorded a token-usage row.
 *
 * Driving from `session_detail` with a LEFT JOIN rather than from
 * `agent_session_token_usage` is what makes the two screens describe the same
 * population, which the copy on both of them claims. An inner join would drop
 * every session that died before writing a usage row — and that is not a random
 * sample: a run killed early by a provider rate limit or an API error is the
 * case LEAST likely to have written one, which is exactly the Systemic bucket
 * the sibling screen puts a spotlight on. The failures it highlights would have
 * looked cheapest.
 */
const SPEND_FROM = Prisma.sql`
  FROM session_detail s
  JOIN artifacts a ON a.id = s.artifact_id
  LEFT JOIN agent_session_token_usage tu ON tu.agent_session_id = s.artifact_id
`;

/**
 * The MODEL population, which is necessarily narrower: a session with no usage
 * row has no model to attribute, so the right-sizing table can only describe
 * sessions that recorded one. Kept as its own inner join rather than filtering
 * {@link SPEND_FROM} downstream, so the narrowing is visible at the source.
 */
const MODEL_SPEND_FROM = Prisma.sql`
  FROM agent_session_token_usage tu
  JOIN session_detail s ON s.artifact_id = tu.agent_session_id
  JOIN artifacts a ON a.id = s.artifact_id
`;

export type SpendGridRow = {
  endsWithError: boolean | null;
  producedArtifact: boolean;
  hasWallClock: boolean;
  status: string | null;
  usd: number | null;
  sessions: number;
};

export type ModelSpendGridRow = SpendGridRow & {
  model: string;
  /**
   * Every billed token — see {@link BILLED_TOKEN_SUM}. This is the RATE
   * denominator and must keep the same population as `usd` beside it; the
   * job-size basis is the separate median read below.
   */
  tokens: number | null;
};

/**
 * Both medians, read together off one pass over the same per-session totals.
 *
 * Both are nullable, and `null` means "no median for this model", which is a
 * different fact from a median of zero. Neither is coerced here — see
 * `tokenops-waste.ts` for why a fabricated `0` is not a safe stand-in on the
 * work basis.
 */
export type ModelMedianRow = {
  model: string;
  /**
   * Median per-session BILLED tokens — see {@link BILLED_TOKEN_SUM}. The
   * original basis of the wire field of the same name, kept unchanged for the
   * deploy window in which `apps/app` is still the old build (ISS-5189).
   */
  medianTokens: number | null;
  /**
   * Median per-session new-work tokens — see {@link WORK_TOKEN_SUM}. A job-size
   * proxy, so prompt-cache replay is not counted as a bigger job. This is the
   * basis the Over-powered verdict's second guard reads.
   */
  medianWorkTokens: number | null;
};

/**
 * Spend and session counts across the outcome grid.
 *
 * `COUNT(DISTINCT s.artifact_id)` because a session carries one usage row per
 * model — counting rows would multiply every session by the number of models it
 * used and inflate each bucket's denominator. Counting the SESSION key rather
 * than the usage key also keeps a session with no usage row in its bucket at
 * zero spend, which is the whole point of the LEFT JOIN above.
 *
 * `COALESCE` on the sum so a bucket of usage-less sessions reports `0` — a
 * measured zero, which is true — rather than `NULL`.
 *
 * Sums are NOT rounded here. Rounding once, at the final projection, keeps the
 * outcome split and the model breakdown reconciling to the same total instead
 * of drifting apart by a fraction of a cent per bucket.
 */
export function fetchSpendGrid(
  scopeSql: Prisma.Sql,
  start: Date,
  end: Date
): Promise<SpendGridRow[]> {
  return withDb((db) =>
    db.$queryRaw<SpendGridRow[]>(Prisma.sql`
      SELECT
        ${SPEND_GRID_SELECT},
        COALESCE(SUM(tu.estimated_cost), 0)::float8 AS "usd",
        COUNT(DISTINCT s.artifact_id)::int AS "sessions"
      ${SPEND_FROM}
      WHERE ${sessionWindow(start, end)}
        AND (${scopeSql})
      GROUP BY ${SPEND_GRID_DIMENSIONS}
    `)
  );
}

/** The same grid, per model, for the right-sizing table. */
export function fetchModelSpendGrid(
  scopeSql: Prisma.Sql,
  start: Date,
  end: Date
): Promise<ModelSpendGridRow[]> {
  return withDb((db) =>
    db.$queryRaw<ModelSpendGridRow[]>(Prisma.sql`
      SELECT
        tu.model AS "model",
        ${SPEND_GRID_SELECT},
        SUM(tu.estimated_cost)::float8 AS "usd",
        SUM(${BILLED_TOKEN_SUM})::float8 AS "tokens",
        COUNT(DISTINCT tu.agent_session_id)::int AS "sessions"
      ${MODEL_SPEND_FROM}
      WHERE ${sessionWindow(start, end)}
        AND (${scopeSql})
      GROUP BY tu.model, ${SPEND_GRID_DIMENSIONS}
    `)
  );
}

/**
 * BOTH per-session medians, per model: the billed basis this screen has always
 * sent, and the new-work basis the Over-powered verdict's second guard reads.
 * See {@link BILLED_TOKEN_SUM} and {@link WORK_TOKEN_SUM} for what separates
 * them.
 *
 * Read together off ONE pass over the same per-session rows rather than as two
 * queries: they describe the same population over the same window, and two
 * reads could settle differently and leave the response quoting two bases from
 * two populations.
 *
 * Computed in its own read over per-session totals rather than folded out of
 * the grid above: a median cannot be recombined from per-bucket medians, and
 * taking one per bucket then averaging would quietly report a number that is
 * not a median of anything.
 */
export function fetchModelMedianTokens(
  scopeSql: Prisma.Sql,
  start: Date,
  end: Date
): Promise<ModelMedianRow[]> {
  return withDb((db) =>
    db.$queryRaw<ModelMedianRow[]>(Prisma.sql`
      WITH per_session AS (
        SELECT
          tu.model AS model,
          tu.agent_session_id AS session_id,
          SUM(${BILLED_TOKEN_SUM})::float8 AS billed_tokens,
          SUM(${WORK_TOKEN_SUM})::float8 AS work_tokens
        ${MODEL_SPEND_FROM}
        WHERE ${sessionWindow(start, end)}
          AND (${scopeSql})
        GROUP BY tu.model, tu.agent_session_id
      )
      SELECT
        model AS "model",
        percentile_cont(0.5) WITHIN GROUP (ORDER BY billed_tokens)::float8
          AS "medianTokens",
        percentile_cont(0.5) WITHIN GROUP (ORDER BY work_tokens)::float8
          AS "medianWorkTokens"
      FROM per_session
      GROUP BY model
    `)
  );
}

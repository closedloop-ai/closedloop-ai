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
 * `s.state` is grouped on because the shared classifier reads it: a run that
 * has not reached a terminal state has no outcome yet, and without the column
 * a live session's `ends_with_error: false` would land its spend in the
 * "Ended clean" bucket.
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
  s.state
`
);

/** The matching SELECT list. Must render byte-identically to the above. */
const SPEND_GRID_SELECT = assertGroupSafe(
  "SPEND_GRID_SELECT",
  Prisma.sql`
  s.ends_with_error AS "endsWithError",
  ${PRODUCED_ARTIFACT} AS "producedArtifact",
  (${WALL_CLOCK_MINUTES} > 0) AS "hasWallClock",
  s.state AS "state"
`
);

const TOKEN_SUM = Prisma.sql`
  (
    tu.input_tokens + tu.output_tokens
    + tu.cache_read_tokens + tu.cache_write_tokens
  )
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
  state: string | null;
  usd: number | null;
  sessions: number;
};

export type ModelSpendGridRow = SpendGridRow & {
  model: string;
  tokens: number | null;
};

export type ModelMedianRow = {
  model: string;
  medianTokens: number | null;
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
        SUM(${TOKEN_SUM})::float8 AS "tokens",
        COUNT(DISTINCT tu.agent_session_id)::int AS "sessions"
      ${MODEL_SPEND_FROM}
      WHERE ${sessionWindow(start, end)}
        AND (${scopeSql})
      GROUP BY tu.model, ${SPEND_GRID_DIMENSIONS}
    `)
  );
}

/**
 * Median tokens per session, per model.
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
          SUM(${TOKEN_SUM})::float8 AS tokens
        ${MODEL_SPEND_FROM}
        WHERE ${sessionWindow(start, end)}
          AND (${scopeSql})
        GROUP BY tu.model, tu.agent_session_id
      )
      SELECT
        model AS "model",
        percentile_cont(0.5) WITHIN GROUP (ORDER BY tokens)::float8
          AS "medianTokens"
      FROM per_session
      GROUP BY model
    `)
  );
}

import { Prisma, withDb } from "@repo/database";
import { runDailyBucketedQuery } from "./lib/daily-buckets";
import {
  dayBucket,
  ENGINEER_NAME,
  FAILURE_THROTTLE_SOURCE,
  NOT_CLEAN_OUTCOME,
  PRODUCED_ARTIFACT,
  SESSION_ANALYTICS_FROM,
  SIGNAL_GRID_GROUP_BY,
  SIGNAL_GRID_SELECT,
  type SignalGridRow,
  sessionWindow,
  WALL_CLOCK_MINUTES,
} from "./session-analytics-sql";

/**
 * The database reads behind the Lost-work screen (ISS-4987).
 *
 * Every read is a GROUP BY that returns a bounded grid of signal buckets, not a
 * per-load scan of raw sessions: the row count is a function of the signal
 * cardinality (outcome × throttle source × artifact × state × wall-clock),
 * multiplied by at most one dimension (day, or person). Classification into
 * loss classes happens once, afterwards, in `session-analytics-classify.ts`.
 */

export type LossTrendGridRow = SignalGridRow & {
  /** `YYYY-MM-DD`, formatted in SQL in the zone the DB actually bucketed in. */
  day: string;
};

export type LossPersonGridRow = SignalGridRow & {
  userId: string | null;
  engineer: string;
  /** In the earlier half of the baseline window. */
  isEarly: boolean;
};

export type LostSessionCandidate = {
  id: string;
  name: string | null;
  engineer: string;
  repositoryFullName: string | null;
  startedAt: Date;
  minutes: number | null;
  endsWithError: boolean | null;
  throttleSource: string | null;
  producedArtifact: boolean;
  state: string | null;
};

/**
 * A BOUNDED PREFILTER, not a second definition of "lost".
 *
 * The authoritative predicate is `isLostSession` in
 * `session-analytics-classify.ts`; this only narrows the candidate set enough
 * that the LIMIT below is meaningful. Every row it returns is re-classified in
 * TypeScript and dropped if the classifier disagrees, so the two can never
 * diverge in a way the user sees — the SQL can only ever be too generous, never
 * too strict about what reaches the screen.
 *
 * Each clause is the SQL mirror of one conjunct of `isLostSession`, and MUST NOT
 * be tightened past it (ISS-5263):
 *
 *   `NOT ${PRODUCED_ARTIFACT}`  ←→ `!signals.producedArtifact`
 *   `${NOT_CLEAN_OUTCOME}`      ←→ `outcomeOf(signals) !== SpendOutcome.Clean`
 *   `${WALL_CLOCK_MINUTES} > 0` ←→ `signals.wallClockMinutes > 0`
 *
 * The outcome clause used to read `s.ends_with_error IS DISTINCT FROM false`,
 * which is STRICTLY narrower than the classifier: it excludes every session
 * carrying `ends_with_error = false`, but the classifier only excludes those
 * that also reached a terminal state. A live session (RUNNING, BLOCKED,
 * IN_REVIEW, PENDING_APPROVAL) carries `false` and classifies Unattributed, so
 * it was counted in the totals above the table and could never be returned for
 * the table itself. `NOT_CLEAN_OUTCOME` is the exact mirror.
 */
const LOST_SESSION_PREFILTER = Prisma.sql`
  NOT ${PRODUCED_ARTIFACT}
  AND ${NOT_CLEAN_OUTCOME}
  AND ${WALL_CLOCK_MINUTES} > 0
`;

/** The whole window's signal grid: totals, systemic causes, behavioral causes. */
export function fetchLossGrid(
  scopeSql: Prisma.Sql,
  start: Date,
  end: Date
): Promise<SignalGridRow[]> {
  return withDb((db) =>
    db.$queryRaw<SignalGridRow[]>(Prisma.sql`
      SELECT ${SIGNAL_GRID_SELECT}
      ${SESSION_ANALYTICS_FROM}
      WHERE ${sessionWindow(start, end)}
        AND (${scopeSql})
      GROUP BY ${SIGNAL_GRID_GROUP_BY}
    `)
  );
}

/**
 * The same grid, bucketed by day, for the trend chart.
 *
 * Runs through {@link runDailyBucketedQuery}, exactly as the sibling
 * `fetchDailySessionSeries` does: a requester timezone is validated only
 * against Node/ICU, so a zone the PG server's tzdata does not know makes
 * `AT TIME ZONE` raise. Without the retry this one widget would settle
 * unavailable on every load for that user while every other Insights chart
 * rendered fine on the UTC fallback.
 *
 * The day key is formatted with `to_char` in SQL rather than round-tripping a
 * `date_trunc` value through the driver, so the key is the calendar day the
 * database bucketed in and cannot be re-shifted by JS. `bucketedZone` is
 * returned so the caller enumerates its day axis in that SAME zone.
 */
export async function fetchLossTrendGrid(
  scopeSql: Prisma.Sql,
  start: Date,
  end: Date,
  timeZone: string | undefined
): Promise<{ rows: LossTrendGridRow[]; bucketedZone: string | undefined }> {
  return await runDailyBucketedQuery(timeZone, (zone) => {
    const day = dayBucket(zone);
    return withDb((db) =>
      db.$queryRaw<LossTrendGridRow[]>(Prisma.sql`
        SELECT to_char(${day}, 'YYYY-MM-DD') AS "day", ${SIGNAL_GRID_SELECT}
        ${SESSION_ANALYTICS_FROM}
        WHERE ${sessionWindow(start, end)}
          AND (${scopeSql})
        GROUP BY "day", ${SIGNAL_GRID_GROUP_BY}
        ORDER BY "day" ASC
      `)
    );
  });
}

/**
 * The same grid per person, split into the earlier and later halves of the
 * baseline window.
 *
 * The split is what makes the anomaly signal a comparison of a person against
 * THEIR OWN earlier baseline rather than against the team — comparing people to
 * each other just ranks whoever ran the most sessions.
 *
 * `splitAt` is a per-request value, so `(s.session_started_at < ${splitAt})`
 * emits a bound parameter and CANNOT be repeated in the GROUP BY: the two
 * interpolations would render different placeholder numbers and Postgres would
 * raise 42803 on `s.session_started_at` (ISS-5263). It is projected once and
 * grouped by its output alias instead, exactly as `fetchLossTrendGrid` groups
 * by `"day"`.
 */
export function fetchLossPersonGrid(
  scopeSql: Prisma.Sql,
  start: Date,
  end: Date,
  splitAt: Date
): Promise<LossPersonGridRow[]> {
  return withDb((db) =>
    db.$queryRaw<LossPersonGridRow[]>(Prisma.sql`
      SELECT
        s.user_id AS "userId",
        ${ENGINEER_NAME} AS "engineer",
        (s.session_started_at < ${splitAt}) AS "isEarly",
        ${SIGNAL_GRID_SELECT}
      ${SESSION_ANALYTICS_FROM}
      LEFT JOIN users u ON u.id = s.user_id
      WHERE ${sessionWindow(start, end)}
        AND (${scopeSql})
      GROUP BY
        s.user_id,
        ${ENGINEER_NAME},
        "isEarly",
        ${SIGNAL_GRID_GROUP_BY}
    `)
  );
}

/**
 * The costliest candidate lost sessions, so a manager can go from a number in
 * the tables above to the actual runs behind it. Bounded by `limit`, ordered by
 * the wall-clock each consumed.
 */
export function fetchLostSessionCandidates(
  scopeSql: Prisma.Sql,
  start: Date,
  end: Date,
  limit: number
): Promise<LostSessionCandidate[]> {
  return withDb((db) =>
    db.$queryRaw<LostSessionCandidate[]>(Prisma.sql`
      SELECT
        s.artifact_id AS "id",
        a.name AS "name",
        ${ENGINEER_NAME} AS "engineer",
        s.repository_full_name AS "repositoryFullName",
        s.session_started_at AS "startedAt",
        ${WALL_CLOCK_MINUTES}::float8 AS "minutes",
        s.ends_with_error AS "endsWithError",
        ${FAILURE_THROTTLE_SOURCE} AS "throttleSource",
        ${PRODUCED_ARTIFACT} AS "producedArtifact",
        s.state AS "state"
      ${SESSION_ANALYTICS_FROM}
      LEFT JOIN users u ON u.id = s.user_id
      WHERE ${sessionWindow(start, end)}
        AND (${scopeSql})
        AND ${LOST_SESSION_PREFILTER}
      ORDER BY ${WALL_CLOCK_MINUTES} DESC
      LIMIT ${limit}
    `)
  );
}

import { Prisma } from "@repo/database";
import {
  FAILURE_THROTTLE_SOURCE_TYPES,
  TERMINAL_AGENT_SESSION_STATES,
} from "./session-analytics-classify";

/**
 * SQL fragments shared by the two session-analytics rollups (ISS-4987 lost work
 * and ISS-4988 TokenOps waste).
 *
 * Both surfaces read the SAME table, the SAME window column, and the SAME scope
 * predicate, so they cannot disagree about which period or population they are
 * describing. The rollup queries GROUP BY the raw signal columns below and
 * return a bounded grid of buckets; the classification into loss classes and
 * spend outcomes then happens once, in TypeScript, via
 * `session-analytics-classify.ts`. That keeps the server free of a second
 * definition of "failed" while still aggregating in the database rather than
 * scanning raw sessions on every page load.
 *
 * Every fragment emits conditions over the `s` (session_detail) and `a`
 * (artifacts) aliases that `SESSION_ANALYTICS_FROM` joins.
 *
 * ---------------------------------------------------------------------------
 * FRAGMENTS REUSED IN BOTH SELECT AND GROUP BY MUST BE PARAMETER-FREE (ISS-5263)
 * ---------------------------------------------------------------------------
 * A `Prisma.sql` fragment carrying a `${value}` emits a BOUND PARAMETER, and
 * every interpolation of that fragment is assigned a FRESH placeholder number.
 * Interpolating the same fragment into a SELECT list and into the matching
 * GROUP BY therefore renders `… / $5` in one and `… / $9` in the other.
 * PostgreSQL compares grouping expressions STRUCTURALLY, sees two different
 * `Param` nodes, refuses to treat them as the same expression, and raises
 * `42803 — column "…" must appear in the GROUP BY clause or be used in an
 * aggregate function`. That took out every widget on both the Lost-work and
 * TokenOps screens from the day they shipped.
 *
 * So: any fragment below that is interpolated into BOTH halves of a grouped
 * read must render byte-identically, which means it must contain NO `${}`
 * values — use `Prisma.raw` for internal, non-user-supplied literals instead.
 * `assertGroupSafe` enforces this at module load, and
 * `session-analytics-group-safety.test.ts` pins it.
 *
 * A per-request value (a date bound, a timezone) can never satisfy that. When
 * one has to appear in a grouped read, project it once with an alias and
 * `GROUP BY "thatAlias"` — see `fetchLossTrendGrid`/`fetchLossPersonGrid`.
 */

const SECONDS_PER_MINUTE = 60;

/**
 * Contract values safe to render as SQL literals: no quotes, no whitespace.
 * Declared here rather than beside `sqlEnumList` at the foot of the file
 * because the exported fragments below evaluate at module load and a `const`
 * declared after them is still in its temporal dead zone.
 */
const SQL_ENUM_VALUE = /^[a-z0-9_]+$/i;

/**
 * Wall-clock a session consumed, in minutes.
 *
 * `session_detail.wall_clock` is a human-formatted string, so the span is
 * derived from timestamps instead. A session that never recorded an end falls
 * back to its last genuine activity (`last_activity_at`, which advances only on
 * real agent activity) before `session_updated_at`, which sync bookkeeping can
 * bump. A negative or absent span clamps to 0 rather than contributing noise.
 *
 * The divisor is a SQL LITERAL, not `${SECONDS_PER_MINUTE}` — see the
 * parameter-free rule in the module header. It is a hardcoded internal
 * constant, never user input, so rendering it raw is safe.
 */
export const WALL_CLOCK_MINUTES = assertGroupSafe(
  "WALL_CLOCK_MINUTES",
  Prisma.sql`
  GREATEST(
    EXTRACT(EPOCH FROM (
      COALESCE(s.session_ended_at, s.last_activity_at, s.session_updated_at)
      - s.session_started_at
    )),
    0
  ) / ${Prisma.raw(String(SECONDS_PER_MINUTE))}
`
);

/**
 * Whether the run yielded anything durable: a pull request, or changed files.
 *
 * TOTAL by construction — it returns true or false for every row, and cannot
 * raise. That is a hard requirement, not defensiveness: `LOST_SESSION_PREFILTER`
 * NEGATES this expression, `NOT NULL` is NULL, and a raise inside the SELECT
 * takes the whole grid down, which `runWidget` settles as an unavailable widget
 * and the screen renders as a blank (ISS-5263).
 *
 * `CASE`, not `AND`, guards the PR leg. `pull_requests` is `Json?` and
 * free-form, so `jsonb_array_length` raises "cannot get array length of a
 * non-array" on a scalar or an object — and PostgreSQL does NOT promise that
 * `AND` short-circuits, so the type test cannot be relied on to keep the length
 * call from being evaluated. The docs point at `CASE` for exactly this, and
 * `FAILURE_THROTTLE_SOURCE` below already guards the identical hazard the same
 * way. The `ELSE false` also settles the NULL row: a run with no recorded PRs
 * and no recorded file changes produced nothing, which is a false, not an
 * unknown, so no outer COALESCE is needed to keep NULL out of the negation.
 *
 * The `files_changed` leg is nullable and COALESCEs to 0 for the same reason.
 */
export const PRODUCED_ARTIFACT = assertGroupSafe(
  "PRODUCED_ARTIFACT",
  Prisma.sql`
  (
    CASE
      WHEN jsonb_typeof(s.pull_requests) = 'array'
      THEN jsonb_array_length(s.pull_requests) > 0
      ELSE false
    END
    OR COALESCE(s.files_changed, 0) > 0
  )
`
);

/**
 * The platform throttle of a FAILURE kind recorded against the run, or NULL
 * when none was. Carrying the source TYPE rather than a boolean means the same
 * grouped read answers "was this systemic" and "what caused it", so the cause
 * shown beside a person's name comes from the same aggregate as their totals
 * and cannot drift from it.
 *
 * `SessionTraceThrottleSourceType.TokenSnapshot` is deliberately excluded: it
 * is a periodic usage sample, not a throttle that cost the run anything.
 * Including it would attribute healthy sessions to the platform and inflate
 * systemic loss.
 *
 * The IN list is rendered as SQL LITERALS rather than `Prisma.join`, which
 * would emit one bound parameter per source type — see the parameter-free rule
 * in the module header. The values are internal contract constants, never user
 * input, and `sqlEnumList` re-proves that at load time before rendering them.
 */
export const FAILURE_THROTTLE_SOURCE = assertGroupSafe(
  "FAILURE_THROTTLE_SOURCE",
  Prisma.sql`
  (
    SELECT throttle ->> 'sourceType'
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(s.throttle_sources) = 'array'
        THEN s.throttle_sources
        ELSE '[]'::jsonb
      END
    ) AS throttle
    WHERE jsonb_typeof(throttle) = 'object'
      AND throttle ->> 'sourceType' IN (${sqlEnumList(
        FAILURE_THROTTLE_SOURCE_TYPES
      )})
    LIMIT 1
  )
`
);

/**
 * The SQL mirror of "this run's outcome was NOT `SpendOutcome.Clean`".
 *
 * `outcomeOf` in `session-analytics-classify.ts` calls a run Clean only when
 * `ends_with_error = false` AND the run has actually finished — a null state
 * (never recorded) or one of {@link TERMINAL_AGENT_SESSION_STATES}. A live row
 * carries `ends_with_error: false` for the reaper's benefit, so a RUNNING,
 * BLOCKED, IN_REVIEW, or PENDING_APPROVAL session is Unknown, not Clean.
 *
 * This exists (ISS-5263) because `LOST_SESSION_PREFILTER` previously spelled the
 * same idea as `s.ends_with_error IS DISTINCT FROM false`, which drops every
 * non-terminal session carrying `false`. Those sessions ARE lost work by the
 * classifier, so they were counted in `totals.sessionsByClass[Unattributed]` and
 * in each engineer's `unattributedSessions` while the prefilter guaranteed they
 * could never appear in the table sitting underneath those numbers — the same
 * totals-vs-table split the `PRODUCED_ARTIFACT` NULL fix closed on the other
 * clause of the same predicate.
 *
 * The outer `COALESCE(…, false)` keeps the expression TOTAL: `ends_with_error`
 * is nullable, so `s.ends_with_error = false` is NULL for a row that never
 * recorded one, and `NOT NULL` is NULL — which would drop exactly the
 * outcome-unknown rows this predicate exists to admit.
 *
 * The state list is rendered as SQL literals via `sqlEnumList` for the same
 * reason `FAILURE_THROTTLE_SOURCE`'s is: internal contract constants, never user
 * input, re-proved at load before they reach SQL.
 */
export const NOT_CLEAN_OUTCOME = Prisma.sql`
  NOT COALESCE(
    s.ends_with_error = false
    AND (
      s.state IS NULL
      OR s.state IN (${sqlEnumList(TERMINAL_AGENT_SESSION_STATES)})
    ),
    false
  )
`;

/** The session population both surfaces describe. */
export const SESSION_ANALYTICS_FROM = Prisma.sql`
  FROM session_detail s
  JOIN artifacts a ON a.id = s.artifact_id
`;

/** Display name for a session's owner, falling back to the email on file. */
export const ENGINEER_NAME = assertGroupSafe(
  "ENGINEER_NAME",
  Prisma.sql`
  COALESCE(
    NULLIF(btrim(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
    u.email,
    'Unknown engineer'
  )
`
);

/**
 * The window predicate. A closed interval on `session_detail.session_started_at`
 * — the SESSION's start, not the usage row's `created_at`, matching every other
 * Insights session aggregate so the same period means the same thing on every
 * screen.
 */
export function sessionWindow(start: Date, end: Date): Prisma.Sql {
  return Prisma.sql`s.session_started_at >= ${start} AND s.session_started_at <= ${end}`;
}

/**
 * One raw signal bucket, before classification. The rollup queries return a
 * grid of these — bounded by the signal cardinality, not by session count —
 * and `session-analytics-classify.ts` folds them into loss classes.
 */
export type SignalGridRow = {
  endsWithError: boolean | null;
  throttleSource: string | null;
  producedArtifact: boolean;
  state: string | null;
  /**
   * Whether the sessions in this bucket consumed any wall-clock. Grouped on, not
   * derived from the summed minutes: without it a bucket mixing a zero-duration
   * session with real ones would sum above zero and count ALL of them as lost,
   * inflating the session count behind every rate on the screen.
   */
  hasWallClock: boolean;
  sessions: number;
  minutes: number | null;
};

/**
 * The GROUP BY grid every lost-work rollup selects. Bounded cardinality.
 *
 * Every fragment interpolated here is ALSO interpolated into
 * {@link SIGNAL_GRID_GROUP_BY}, so each one must be parameter-free — see the
 * module header.
 *
 * Guarded itself, not only through its parts: this pair IS the SELECT/GROUP BY
 * split that ISS-5263 broke, so a per-request bound added directly to either
 * half — rather than to one of the fragments below — must also fail at load
 * rather than at plan time. `COUNT`/`SUM` mean this half is never interpolated
 * into a GROUP BY on its own, but it is one of the two expressions that have to
 * render identically, so it carries the same obligation.
 */
export const SIGNAL_GRID_SELECT = assertGroupSafe(
  "SIGNAL_GRID_SELECT",
  Prisma.sql`
  s.ends_with_error AS "endsWithError",
  ${FAILURE_THROTTLE_SOURCE} AS "throttleSource",
  ${PRODUCED_ARTIFACT} AS "producedArtifact",
  s.state AS "state",
  (${WALL_CLOCK_MINUTES} > 0) AS "hasWallClock",
  COUNT(*)::int AS "sessions",
  COALESCE(SUM(${WALL_CLOCK_MINUTES}), 0)::float8 AS "minutes"
`
);

/**
 * The matching GROUP BY. Must render byte-identically to the expressions in
 * {@link SIGNAL_GRID_SELECT} — see the module header.
 */
export const SIGNAL_GRID_GROUP_BY = assertGroupSafe(
  "SIGNAL_GRID_GROUP_BY",
  Prisma.sql`
  s.ends_with_error,
  ${FAILURE_THROTTLE_SOURCE},
  ${PRODUCED_ARTIFACT},
  s.state,
  (${WALL_CLOCK_MINUTES} > 0)
`
);

/** Signals for one grid row, in the shape the shared classifier reads. */
export function signalsOf(row: SignalGridRow): {
  endsWithError: boolean | null;
  hasFailureThrottle: boolean;
  producedArtifact: boolean;
  state: string | null;
  wallClockMinutes: number;
} {
  return {
    endsWithError: row.endsWithError,
    hasFailureThrottle: row.throttleSource !== null,
    producedArtifact: row.producedArtifact,
    state: row.state,
    wallClockMinutes: row.hasWallClock ? Number(row.minutes ?? 0) : 0,
  };
}

/**
 * Daily bucket expression over `session_started_at`, labelled in the
 * requester's timezone so the analytics screens bucket the same activity on the
 * same calendar day as every other Insights chart.
 *
 * The explicit `AT TIME ZONE 'UTC'` anchor before the target zone keeps the
 * round-trip independent of the PG session timezone; `canonicalizeTimeZone`
 * upstream has already rejected bare offsets, which PG mis-signs.
 */
export function dayBucket(timeZone: string | undefined): Prisma.Sql {
  return timeZone
    ? Prisma.sql`date_trunc('day', (s.session_started_at AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})`
    : Prisma.sql`date_trunc('day', s.session_started_at)`;
}

/**
 * Render a fixed set of internal contract values as a SQL literal list.
 *
 * `Prisma.join` would be the obvious call, but it emits one BOUND PARAMETER per
 * value, which makes the containing fragment unusable in a GROUP BY that also
 * appears in the SELECT list — see the module header. These are const-object
 * enum members, never user input; the shape check is here so a future value
 * that could not be rendered safely fails at load rather than reaching SQL.
 */
function sqlEnumList(values: readonly string[]): Prisma.Sql {
  const unsafe = values.filter((value) => !SQL_ENUM_VALUE.test(value));
  if (unsafe.length > 0 || values.length === 0) {
    throw new Error(
      `sqlEnumList expects a non-empty list of bare alphanumeric contract values; got ${JSON.stringify(values)}`
    );
  }
  return Prisma.raw(values.map((value) => `'${value}'`).join(", "));
}

/**
 * Guard for the module-header rule: return the fragment unchanged when it
 * carries no bound parameters, and throw at load when it does.
 *
 * A load-time throw rather than a lint rule, because the failure it prevents is
 * invisible until a real Postgres plans the query — the unit suites mock the
 * client away, which is exactly how ISS-5263 shipped and stayed broken.
 */
export function assertGroupSafe(
  name: string,
  fragment: Prisma.Sql
): Prisma.Sql {
  if (fragment.values.length > 0) {
    throw new Error(
      `${name} is interpolated into both a SELECT list and a GROUP BY, so it must carry no bound parameters (ISS-5263). Use a SQL literal for internal constants, or project the value once and GROUP BY its alias.`
    );
  }
  return fragment;
}

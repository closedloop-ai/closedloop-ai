/**
 * @file claude-code-telemetry-candidates.ts
 * @description ISS-11322 / ISS-11323 — which sessions the Claude Code telemetry
 * lane owes a delivery, and the bound that keeps asking cheap.
 *
 * Split out of `claude-code-telemetry-rollup.ts`, which owns what a delivery
 * CARRIES. This module owns the prior question: which sessions are owed one.
 *
 * ── ALL FOURTEEN FAMILIES ARE OPERANDS (ISS-11322) ──────────────────────────
 * ISS-10717 shipped eight. The other six were a deliberate CUT, because what the
 * rollup would carry for three of them is not a count and picking that grain was
 * a decision #7722 declined to make inside a review pass. The CANDIDATE question
 * never depended on that grain, and leaving them out had two measured
 * consequences: a session whose only rows are in one of the six was never
 * selected, so its telemetry never left the machine; and a later write into one
 * of the six could not make an already-delivered session owed again, because the
 * watermark comparison could not see it. Both are closed by listing all
 * fourteen here.
 *
 * `claude_code_session_identity` is the one operand with NO index on its instant
 * column — it is keyed `@id` on `session_id`, so it holds at most one row per
 * session and a scan of it is a scan of the session table's worth of rows rather
 * than of an event corpus. Stated rather than silently relied on: it is the
 * operand the per-session floor below cannot make into an index seek.
 *
 * ── THE PER-SESSION FLOOR (ISS-11323) ───────────────────────────────────────
 * This query runs every 15 seconds forever, including once the lane has drained.
 * Before ISS-11323 every operand was `WHERE <col> GLOB <canonical UTC form>`
 * and nothing else, and a GLOB pattern with no literal prefix cannot use
 * `idx_claude_code_*_observed`, so the steady-state pass scanned every row of
 * every family and then built a temp b-tree over the lot. ISS-7352 measured
 * 32,930 `claude_code_cost_event` rows on one machine.
 *
 * The floor is CORRELATED PER SESSION, derived from that session's OWN cursor
 * row, and the no-cursor case is ADMITTED. A global floor —
 * `MIN(synced_observed_to)` across the cursor table, which is what the original
 * review comment suggested — is UNSAFE and must not be reintroduced: a session
 * that has never been delivered has no cursor row, contributes nothing to that
 * MIN, and is protected by no floor, so an old never-delivered session whose
 * rows predate the global minimum is excluded from every operand and stranded
 * permanently with nothing red anywhere. That population is precisely the one
 * this lane exists to drain.
 *
 * ── THE DIRTY PREDICATE LIVES IN EXACTLY ONE PLACE ──────────────────────────
 * The floor is stated as the NEGATION of "this row is already covered", which
 * makes it the whole dirty predicate rather than one arm of it. A row is
 * excluded only when a cursor exists for the session AND that cursor was written
 * under the CURRENT revision AND the session is not inside its `session_absent`
 * re-admission window AND the row is at or below the acknowledged watermark. So
 * every arm ISS-10717 put in the outer `HAVING` — no cursor, stale
 * `data_revision`, corpus past the watermark, the `session_absent` door with its
 * cooldown — is preserved, and the outer `HAVING` is GONE rather than kept
 * alongside it. Two copies of one predicate is a drift defect: the copies would
 * have to be edited together forever, and the day they disagreed the lane would
 * either strand telemetry or re-send it with nothing to say which copy was
 * wrong.
 *
 * The watermark the lane persists is unchanged by the floor. For a
 * watermark-dirty session the admitted rows are exactly those past the
 * watermark, and their `MAX` is the corpus `MAX` because the corpus `MAX` is
 * itself past the watermark; for every other arm no row is excluded at all.
 */

import { effectiveDataRevision } from "../collectors/engine/effective-data-revision.js";
import type { DesktopPrismaReadClient } from "../database/prisma-client.js";
import { CANONICAL_UTC_TIMESTAMP_GLOB_SQL } from "../database/session-timestamp-form.js";

/** One session owed a delivery, with the watermark that made it owed. */
export type ClaudeCodeTelemetryCandidate = {
  sessionId: string;
  /** The newest instant across every family, as stored (ISO text). */
  latestObservedAt: string;
};

type CandidateRow = {
  session_id: string;
  latest_observed_at: string | null;
};

/**
 * Every `claude_code_*` SIGNAL table and the instant column it actually has and
 * indexes, as `(table, column)`.
 *
 * `claude_code_signal_drop` and `claude_code_telemetry_sync_cursor` are the
 * lane's own infrastructure and are deliberately absent — they are not signals.
 *
 * The two REQUEST tables carry `started_at`; every other family carries
 * `observed_at`.
 *
 * EXPORTED so a test can hold this list against the schema's own count. The
 * whole ISS-11322 defect was a list that was SHORTER than the set of signal
 * tables, and nothing failed when it was.
 */
export const CLAUDE_CODE_SIGNAL_SOURCES: readonly (readonly [
  string,
  string,
])[] = [
  ["claude_code_cost_event", "observed_at"],
  ["claude_code_api_request", "started_at"],
  ["claude_code_error_event", "observed_at"],
  ["claude_code_permission_event", "observed_at"],
  ["claude_code_permission_mode_change", "observed_at"],
  ["claude_code_mcp_server_connection", "observed_at"],
  ["claude_code_tool_result", "observed_at"],
  ["claude_code_llm_request", "started_at"],
  ["claude_code_auth_event", "observed_at"],
  ["claude_code_plugin_event", "observed_at"],
  ["claude_code_lines_of_code", "observed_at"],
  ["claude_code_session_start", "observed_at"],
  ["claude_code_active_time", "observed_at"],
  ["claude_code_session_identity", "observed_at"],
];

/**
 * The union that defines "this session has Claude Code OTel rows the cloud has
 * not acknowledged, and this is how fresh they are".
 *
 * A UNION ALL over the families rather than fourteen separate reads: the
 * candidate question is answered once per tick for the whole machine, and
 * running it per family would make the lane's selection cost scale with the
 * table count.
 *
 * EVERY OPERAND IS GLOB-GUARDED TO THE FIXED-WIDTH CANONICAL UTC FORM, because
 * these are TEXT columns and the `MAX` below would otherwise be a BYTE
 * comparison: `…:00Z` sorts after `…:00.500Z` while being the EARLIER instant,
 * and an offset form loses outright, so the watermark would name the wrong row
 * and a session could be marked delivered past telemetry it never sent. The
 * guard excludes nothing this repo writes — every one of these columns is
 * produced by `Date#toISOString()` in the normalizer — and a value it did
 * exclude is one whose instant this lane cannot order, which is a refusal rather
 * than a confident wrong answer.
 *
 * `COALESCE(f.last_error, '')` is load-bearing and the other columns need no
 * such guard: `last_error` is the only nullable column this predicate reads, and
 * a bare `f.last_error = ?4` against a NULL yields NULL, which propagates
 * through the `NOT (…)` and makes the whole `NOT EXISTS` admit every row — the
 * floor silently doing nothing on the steady-state majority, which is the case
 * it exists for.
 */
const CANDIDATE_OBSERVATION_UNION = CLAUDE_CODE_SIGNAL_SOURCES.map(
  ([table, column]) =>
    `SELECT session_id, ${column} AS observed FROM ${table}
        WHERE ${column} GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
          AND NOT EXISTS (
                SELECT 1 FROM claude_code_telemetry_sync_cursor f
                 WHERE f.source_key = ?1
                   AND f.session_id = ${table}.session_id
                   AND f.data_revision = ?3
                   AND NOT (COALESCE(f.last_error, '') = ?4
                            AND f.updated_at < ?5)
                   AND ${table}.${column} <= f.synced_observed_to
              )`
).join("\n  UNION ALL ");

/**
 * Sessions whose corpus has moved since their last verified delivery, oldest
 * owed first.
 *
 * OLDEST FIRST is what makes the lane drain rather than starve: newest-first
 * would let a busy session's fresh rows monopolize every tick while an old
 * session that has never synced stays owed forever.
 *
 * The dirty predicate is the per-operand floor documented at the top of this
 * file, not a clause here. A session reaching this `GROUP BY` at all is a
 * session with at least one unacknowledged row.
 *
 * The revision arm of that floor is invariant 7 (`main/sync/AGENTS.md`): a
 * change to what the rollup COMPUTES moves no `claude_code_*` row, so without it
 * an already-synced session would keep its stale cloud rollup forever, with no
 * way to force a re-walk.
 *
 * THE `session_absent` ARM IS A RECOVERY DOOR. Passing a session the cloud has
 * no row for advances its watermark, which is what stops it occupying a page
 * slot forever — but a FINISHED session grows no further rows, so nothing would
 * ever make it owed again. The cloud row is created by the SESSION lane, and a
 * metadata-sync outage longer than that ceiling is exactly the case where the
 * row appears AFTER the pass. Without this arm the telemetry for those sessions
 * is permanently stranded on the machine, which is the failure ISS-10717 exists
 * to end rather than an acceptable dead letter.
 *
 * It re-admits only rows passed for THAT reason, and only once per cooldown: the
 * row's `updated_at` moves on every pass, so a session whose cloud row genuinely
 * never appears costs one delivery attempt per cooldown rather than one per
 * tick. A `payload_rejected` pass is NOT re-admitted — that one is attributable
 * to the payload and repeating it would just re-spend the budget.
 */
export async function loadClaudeCodeTelemetryCandidates(
  client: DesktopPrismaReadClient,
  sourceKey: string,
  limit: number,
  now: () => Date = () => new Date()
): Promise<ClaudeCodeTelemetryCandidate[]> {
  const absentRetryBefore = new Date(
    now().getTime() - SESSION_ABSENT_RETRY_COOLDOWN_MS
  ).toISOString();
  // lexical-timestamp-ok: every operand of the MAX and of the ORDER BY below
  // comes from CANDIDATE_OBSERVATION_UNION, which GLOB-filters each column to
  // the fixed-width canonical UTC form upstream, so byte order over them IS time
  // order. The cursor columns the floor compares are only ever written from one
  // of those same filtered values.
  const rows = await client.$queryRawUnsafe<CandidateRow[]>(
    `SELECT o.session_id AS session_id,
            MAX(o.observed) AS latest_observed_at
       FROM (${CANDIDATE_OBSERVATION_UNION}) AS o
      GROUP BY o.session_id
      ORDER BY latest_observed_at ASC
      LIMIT ?2`,
    sourceKey,
    limit,
    effectiveDataRevision(),
    CLAUDE_CODE_TELEMETRY_SESSION_ABSENT_ERROR,
    absentRetryBefore
  );
  const candidates: ClaudeCodeTelemetryCandidate[] = [];
  for (const row of rows) {
    if (row.latest_observed_at) {
      candidates.push({
        sessionId: row.session_id,
        latestObservedAt: row.latest_observed_at,
      });
    }
  }
  return candidates;
}

/**
 * How long a session passed for `session_absent` waits before the lane tries it
 * again.
 *
 * Long enough that a session whose cloud row will never exist costs one attempt
 * every few hours rather than one per 15s tick, and short enough that a
 * metadata-sync outage does not strand a day of telemetry.
 */
const SESSION_ABSENT_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * The `last_error` value the recovery arm re-admits.
 *
 * Declared here rather than imported from the lane service because this module
 * is the lane's READ half and importing the writer would close a cycle. Exported
 * so a test can pin it to `ClaudeCodeTelemetrySyncLocalError.SessionAbsent`,
 * which is the only thing that writes this column: without that pin the two
 * spellings could drift and the door would silently stop opening.
 */
export const CLAUDE_CODE_TELEMETRY_SESSION_ABSENT_ERROR = "session_absent";

import type { ActivityHeatmap } from "@repo/api/src/types/insights";
import { Prisma, withDb } from "@repo/database";
import {
  HEADLESS_ENTRYPOINT_PREFIXES,
  HEADLESS_ENTRYPOINT_TOKENS,
  HEADLESS_PERMISSION_MODES,
} from "@repo/lib/session-trace/headless";
import { toNumber } from "@/lib/prisma-number";
import { eachDayKey, runDailyBucketedQuery } from "./daily-buckets";

/**
 * The cloud `activityHeatmap` derivation, extracted from `service.ts` (ISS-5408)
 * — that file is a grandfathered over-ceiling module under the repo's 1,000-line
 * rule and this change would otherwise have grown it.
 *
 * ## What an Agent turn is, and why it is no longer a `$.messages` row
 *
 * FEA-3684 moved this chart server-side and counted an Agent turn as one
 * `$.messages` row with `role='assistant'`. That is the wrong unit, for the same
 * reason FEA-3597 abandoned it on the desktop: Claude Code writes one JSONL line
 * per content BLOCK, so a single billable round-trip splits across
 * text/tool_use/thinking rows and inflates the count (measured 2.8–68x, see
 * `@repo/lib/harness/usage-dedup`). The desktop's `session_turn_bucket` now
 * derives Agent rows from the billable round-trip series instead.
 *
 * The cloud could not simply adopt that rule, because the desktop derives it
 * from `metadata.tokenSeries` — the sole member of `OMITTED_METADATA_KEYS`,
 * stripped before sync, so the series never reaches this side.
 *
 * ## Why this reads `agent_session_token_events` instead (ISS-5408)
 *
 * It does not need to. The cloud ALREADY receives the round-trip series under a
 * different name: the desktop's local `token_events` table is materialized from
 * the very same parsed `tokenSeries` array (`write-core.ts` assigns
 * `tokenEventsRecords = tokenSeries`), and that table is synced verbatim into
 * `agent_session_token_events`, one row per billable round-trip, with
 * `event_created_at` carrying the identical parse-time instant. Verified against
 * a live desktop store: `COUNT(token_events)` equals `json_array_length($.tokenSeries)`
 * EXACTLY on every session sampled (18052/18052, 6250/6250, 6220/6220).
 *
 * So the fix is a read change, not a sync-contract change: no new synced field,
 * no payload growth, no version-skew window, and — decisively — no exposure to
 * `MAX_METADATA_MESSAGES` (100), which caps `$.messages` and therefore bit
 * hardest on exactly the high-turn sessions this correction targets.
 *
 * ## Parent vs. folded sub-agent
 *
 * A folded sub-agent has no session row of its own, so its round-trips must roll
 * up to the parent's timeline — the model ISS-5395 establishes on the desktop.
 * This side gets that for free and cannot do otherwise: `subagentId` exists only
 * at parse time and is dropped at the desktop's `token_events` write boundary
 * (that table has no subagent column), so every synced round-trip — parent- and
 * subagent-attributed alike — arrives here as an undifferentiated row. That is
 * precisely "the billable round-trips the session actually performed".
 *
 * That lands this side on the SAME unit the desktop now uses: ISS-5395 stopped
 * `session_turn_bucket` consulting `subagentId`, so on every session that SYNCED
 * a round-trip series both surfaces count every billable round-trip and the
 * Cloud/LocalElectron fork this ticket describes is closed. FEA-3597's original
 * parent-ONLY filter was the gap — measured on a live store, a 95.6%-delegating
 * session bucketed 786 agent turns locally against 18,052 real round-trips.
 *
 * The fork is NOT closed on the fallback population below, and this is the
 * accurate statement of which way it still runs. `deriveSessionTurnBuckets`
 * (apps/desktop/src/main/database/turn-buckets.ts) has no legacy fallback —
 * `collectAgentUnits` yields nothing when `$.tokenSeries` is absent — so a
 * Codex-OTel or pre-FEA-2730 session contributes ZERO Agent cells on the
 * desktop, where this side gives it its legacy `$.messages` count. The two
 * therefore still disagree on exactly that set, and `overlayLocalActivityHeatmap`
 * does not reconcile them: it splices the local read in only when the cloud slice
 * has NO cells at all, so once cloud returns anything it wins for the whole
 * payload. Cloud reads HIGHER there by construction, which is the safe direction
 * for a false-idle ticket — a busy period renders busy — but it is a divergence,
 * not parity, and closing it means giving the desktop the same fallback.
 *
 * On a NON-delegating session the parent-only and all-round-trips rules are
 * arithmetically identical (there are no subagent-attributed entries to filter),
 * so the common case is unmoved relative to the desktop under either rule —
 * verified at 35/35, 49/49, 23/23 on the same store.
 *
 * ## Human turns are unchanged
 *
 * Human turns still come from `$.messages` (`role='human'` AND the session is
 * NOT headless), mirroring the desktop's `collectHumanUnits`. The two halves
 * read INDEPENDENT sources and are guarded independently, exactly as
 * `deriveSessionTurnBuckets` does: a session with round-trips but absent/
 * malformed `$.messages` must still get its Agent cells, and vice versa.
 *
 * Note the headless classifier's role NARROWS on the round-trip path, matching
 * the desktop. It used to both suppress the Human row AND promote that turn to
 * an Agent row; the promotion is moot there, because those Agent cells no longer
 * come from `$.messages` at all. The suppression half is still load-bearing.
 *
 * The promotion is NOT gone repo-wide: it survives, deliberately, on the legacy
 * fallback below, which still reads `$.messages` and would otherwise strand a
 * headless session's prompts in neither half. See
 * {@link agentLegacyMessageRowsSql}.
 *
 * ## Sessions that synced no round-trip series
 *
 * Not every session has token events: the Codex OTel writer persists to
 * `token_usage` but not `token_events` (see the desktop `token-parity` note),
 * and pre-FEA-2730 rows predate the lane. Counting those as zero Agent turns
 * would render a genuinely busy period as idle — the exact failure this ticket
 * exists to prevent — so such sessions fall back to their legacy `$.messages`
 * count: assistant rows PLUS, when the session is headless, its injected `human`
 * prompts, which is the prior expression term for term. The fallback is per
 * SESSION, applies only where the better basis is absent, and is strictly the
 * PRIOR behavior, so it can never regress a session that renders correctly
 * today. Dropping the headless term is what would regress it — see
 * {@link agentLegacyMessageRowsSql}.
 */

/**
 * SQL predicate that mirrors `isHeadlessSession` (@repo/lib session-trace) over a
 * session's synced `metadata` JSON: the `entrypoint` starts with a headless SDK
 * prefix (`sdk-…`) OR contains an autonomous token (`exec`), OR `permissionMode`
 * is an exact automation value (`bypassPermissions`). Built from the SAME SSOT
 * constant lists the JS helper and the desktop rollup's `headlessMetadataSql` use,
 * so the three predicates can never drift. All terms are fixed literals with no
 * LIKE wildcards, bound as parameters. `->>` yields NULL for an absent
 * entrypoint/permissionMode, so a missing signal is never headless.
 */
function headlessSessionSql(): Prisma.Sql {
  const entrypoint = Prisma.sql`lower(s.metadata ->> 'entrypoint')`;
  const conditions: Prisma.Sql[] = [
    ...HEADLESS_ENTRYPOINT_PREFIXES.map(
      (prefix) => Prisma.sql`${entrypoint} LIKE ${`${prefix.toLowerCase()}%`}`
    ),
    ...HEADLESS_ENTRYPOINT_TOKENS.map(
      (token) => Prisma.sql`${entrypoint} LIKE ${`%${token.toLowerCase()}%`}`
    ),
    ...HEADLESS_PERMISSION_MODES.map(
      (mode) => Prisma.sql`(s.metadata ->> 'permissionMode') = ${mode}`
    ),
  ];
  return Prisma.join(conditions, " OR ");
}

/**
 * Re-bucket a UTC `timestamp` column/expression into the requester's calendar.
 *
 * Both sources store a UTC wall-clock instant in a zone-less `timestamp`:
 * `$.messages[].timestamp` is an ISO string cast with `::timestamp` (which drops
 * any offset), and `agent_session_token_events.event_created_at` is a
 * `timestamp(3) without time zone` written from the same parse-time instant. So
 * the identical `AT TIME ZONE 'UTC' → AT TIME ZONE zone` round-trip applies to
 * both, matching the desktop's SQLite `strftime(ts, 'localtime')`, which also
 * reads the stored value as UTC. `undefined` ⇒ bucket in UTC.
 */
function localTsSql(
  utcTs: Prisma.Sql,
  timeZone: string | undefined
): Prisma.Sql {
  if (!timeZone) {
    return utcTs;
  }
  return Prisma.sql`((${utcTs}) AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}`;
}

/**
 * Human turns from `$.messages`, unchanged from FEA-3684 apart from dropping the
 * headless→Agent promotion (see the module doc).
 *
 * Malformed metadata, a non-array `messages`, a non-object element, a
 * non-`human` role, or a `timestamp` that isn't a string Postgres accepts as a
 * FULL-STRING `timestamp` are all skipped rather than aborting the scan. The row
 * filter uses `pg_input_is_valid(text, 'timestamp')` (PG 16+), which validates
 * the entire string without ever raising — so a calendar-invalid date (Feb 30,
 * month 13, hour 25), a valid prefix followed by trailing junk, and any
 * empty/blank/non-date text all return `false` and never reach the `::timestamp`
 * cast in the SELECT. A single malformed synced row therefore drops out of the
 * buckets instead of 500-ing the whole `/insights/utilization` endpoint.
 */
function humanTurnsSql(
  scopeSql: Prisma.Sql,
  trendStart: Date,
  end: Date,
  timeZone: string | undefined
): Prisma.Sql {
  const localTs = localTsSql(
    Prisma.sql`(m ->> 'timestamp')::timestamp`,
    timeZone
  );
  return Prisma.sql`
    SELECT
      to_char(${localTs}, 'YYYY-MM-DD') AS day,
      EXTRACT(HOUR FROM ${localTs})::int AS hour,
      1 AS human,
      0 AS agent
    FROM session_detail s
    JOIN artifacts a ON a.id = s.artifact_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(s.metadata -> 'messages') = 'array'
        THEN s.metadata -> 'messages'
        ELSE '[]'::jsonb
      END
    ) AS m
    WHERE s.session_started_at >= ${trendStart}
      AND s.session_started_at <= ${end}
      AND jsonb_typeof(m) = 'object'
      AND (m ->> 'role') = 'human'
      AND jsonb_typeof(m -> 'timestamp') = 'string'
      AND pg_input_is_valid((m ->> 'timestamp'), 'timestamp')
      -- COALESCE to false: headlessSessionSql is an OR of LIKE/eq terms over
      -- entrypoint/permissionMode, each of which is NULL (not false) when its
      -- signal is absent, so the whole predicate is NULL for a session with
      -- neither key. A NULL headless would make NOT headless evaluate to NULL
      -- and silently drop a genuine human turn. An absent signal means not
      -- headless (matching isHeadlessSession), so pin it to false.
      AND NOT COALESCE((${headlessSessionSql()}), false)
      AND (${scopeSql})
  `;
}

/**
 * Agent turns as BILLABLE ROUND-TRIPS — one row per synced
 * `agent_session_token_events` record (see the module doc for why this is the
 * right unit and why the cloud already holds it).
 *
 * Sessions are filtered by `session_started_at` within the capped trend window,
 * then each round-trip buckets by its OWN local (day, hour) — the same shape as
 * the human half and as the desktop read, so a round-trip whose timestamp falls
 * outside the rendered day axis simply doesn't match a column.
 *
 * The join enters through `session_detail`, which is the sanctioned access path
 * for this table: it carries no `organizationId` of its own by design (PRD-510
 * D4), so org isolation comes from the `session → artifact` relation exactly as
 * every other cloud reader of it does.
 */
function agentRoundTripsSql(
  scopeSql: Prisma.Sql,
  trendStart: Date,
  end: Date,
  timeZone: string | undefined
): Prisma.Sql {
  const localTs = localTsSql(Prisma.sql`te.event_created_at`, timeZone);
  return Prisma.sql`
    SELECT
      to_char(${localTs}, 'YYYY-MM-DD') AS day,
      EXTRACT(HOUR FROM ${localTs})::int AS hour,
      0 AS human,
      1 AS agent
    FROM agent_session_token_events te
    JOIN session_detail s ON s.artifact_id = te.agent_session_id
    JOIN artifacts a ON a.id = s.artifact_id
    WHERE s.session_started_at >= ${trendStart}
      AND s.session_started_at <= ${end}
      AND (${scopeSql})
  `;
}

/**
 * Legacy Agent fallback for sessions that synced NO round-trip series at all.
 *
 * Without this, a Codex-OTel or pre-FEA-2730 session would contribute zero Agent
 * cells and a genuinely busy period would render as idle. The `NOT EXISTS` makes
 * the fallback strictly disjoint from {@link agentRoundTripsSql}: a session is
 * counted on exactly one basis, never both, so the two can never double-count.
 *
 * The role predicate reproduces the PRIOR expression EXACTLY —
 * `role = 'assistant' OR headless` over rows filtered to `role IN
 * ('human','assistant')` — and the headless disjunct is load-bearing, not
 * vestigial. On this path Agent cells still come from `$.messages`, so the
 * headless→Agent PROMOTION that {@link agentRoundTripsSql} makes obsolete is
 * still the only thing that homes a headless session's injected `human` prompts:
 * `humanTurnsSql` excludes those same rows via `NOT COALESCE(headless, false)`.
 * Drop the disjunct and a session that is headless AND synced no token events
 * has its prompts counted in NEITHER half — they leave the grid entirely, and a
 * day whose only activity was `codex exec` runs goes from lit to blank, which is
 * the same false-idle failure this fallback exists to prevent. That population
 * is not hypothetical: `codex exec` matches `HEADLESS_ENTRYPOINT_TOKENS` while
 * the Codex OTel writer persists `token_usage` and not `token_events`.
 *
 * Keeping it also keeps this branch STRICTLY the prior behavior, which is the
 * property the module doc's no-regression guarantee rests on, and keeps the card
 * consistent with the FEA-2641 Fix 4 PM ruling that `EventActivityHeatmap` still
 * states: a headless session's kickoff prompt is programmatic, not typed, and
 * counts as Agent.
 *
 * Every `$.messages` row of a no-token-event session therefore lands in EXACTLY
 * one bucket: `human` + not headless ⇒ Human, `human` + headless ⇒ Agent,
 * `assistant` ⇒ Agent.
 */
function agentLegacyMessageRowsSql(
  scopeSql: Prisma.Sql,
  trendStart: Date,
  end: Date,
  timeZone: string | undefined
): Prisma.Sql {
  const localTs = localTsSql(
    Prisma.sql`(m ->> 'timestamp')::timestamp`,
    timeZone
  );
  return Prisma.sql`
    SELECT
      to_char(${localTs}, 'YYYY-MM-DD') AS day,
      EXTRACT(HOUR FROM ${localTs})::int AS hour,
      0 AS human,
      1 AS agent
    FROM session_detail s
    JOIN artifacts a ON a.id = s.artifact_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(s.metadata -> 'messages') = 'array'
        THEN s.metadata -> 'messages'
        ELSE '[]'::jsonb
      END
    ) AS m
    WHERE s.session_started_at >= ${trendStart}
      AND s.session_started_at <= ${end}
      AND NOT EXISTS (
        SELECT 1
        FROM agent_session_token_events te
        WHERE te.agent_session_id = s.artifact_id
      )
      AND jsonb_typeof(m) = 'object'
      AND (
        (m ->> 'role') = 'assistant'
        OR (
          (m ->> 'role') = 'human'
          AND COALESCE((${headlessSessionSql()}), false)
        )
      )
      AND jsonb_typeof(m -> 'timestamp') = 'string'
      AND pg_input_is_valid((m ->> 'timestamp'), 'timestamp')
      AND (${scopeSql})
  `;
}

/**
 * FEA-3684 / ISS-5408: hour×day Human/Agent turn-density heatmap, computed
 * server-side so the Event Activity card is served consistently to any
 * authenticated surface (web dashboard AND desktop Cloud mode).
 *
 * Buckets in `timeZone`, degrading to UTC when the PG server's tzdata rejects
 * the zone (see {@link runDailyBucketedQuery}), and enumerates the day axis in
 * the SAME zone the rows were keyed in.
 *
 * Residual bound, unchanged by ISS-5408 and stated so it is not mistaken for
 * exactness: the HUMAN half still reads `$.messages`, which the cloud persists
 * capped at `MAX_METADATA_MESSAGES` (100) per session, so a very high-turn
 * session's human tail is not counted. The Agent half is no longer subject to
 * that cap because it no longer reads `$.messages`.
 */
export async function fetchActivityHeatmap(
  scopeSql: Prisma.Sql,
  requestedTimeZone: string | undefined,
  trendStart: Date,
  end: Date
): Promise<ActivityHeatmap> {
  const runQuery = (timeZone: string | undefined) => {
    const sources = Prisma.join(
      [
        humanTurnsSql(scopeSql, trendStart, end, timeZone),
        agentRoundTripsSql(scopeSql, trendStart, end, timeZone),
        agentLegacyMessageRowsSql(scopeSql, trendStart, end, timeZone),
      ],
      " UNION ALL "
    );
    return withDb((db) =>
      db.$queryRaw<
        { day: string; hour: number; human: number; agent: number }[]
      >(
        Prisma.sql`
          SELECT
            day,
            hour,
            SUM(human)::int AS human,
            SUM(agent)::int AS agent
          FROM (${sources}) turns
          GROUP BY day, hour
        `
      )
    );
  };
  const { rows, bucketedZone } = await runDailyBucketedQuery(
    requestedTimeZone,
    runQuery
  );
  // Sort by (day, hour) so the emitted cells are deterministically ordered.
  const cells = rows
    .map((row) => ({
      day: row.day,
      hour: toNumber(row.hour),
      human: toNumber(row.human),
      agent: toNumber(row.agent),
    }))
    .sort((left, right) => {
      if (left.day !== right.day) {
        return left.day < right.day ? -1 : 1;
      }
      return left.hour - right.hour;
    });
  return {
    // Contiguous day columns over the capped trend window (matches the "Last 90
    // days (max)" caption), keyed in the same zone the rows were bucketed in.
    days: eachDayKey(trendStart, end, bucketedZone),
    cells,
  };
}

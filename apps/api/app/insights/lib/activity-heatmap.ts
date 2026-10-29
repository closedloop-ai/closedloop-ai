import type { ActivityHeatmap } from "@repo/api/src/types/insights";
import { Prisma, withDb } from "@repo/database";
import { AGENT_TURN_TIMESTAMPS_METADATA_KEY } from "@repo/lib/agent-sessions/agent-turn-timestamps";
import { HUMAN_TURN_TIMESTAMPS_METADATA_KEY } from "@repo/lib/agent-sessions/human-turn-timestamps";
import {
  HEADLESS_ENTRYPOINT_PREFIXES,
  HEADLESS_ENTRYPOINT_TOKENS,
  HEADLESS_PERMISSION_MODES,
} from "@repo/lib/session-trace/headless";
import { toNumber } from "@/lib/prisma-number";
import { eachDayKey, runDailyBucketedQuery } from "./daily-buckets";

/**
 * The cloud `activityHeatmap` derivation, extracted from `service.ts` (ISS-5408)
 * — this change would otherwise have grown that file.
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
 * ## Human turns (ISS-7896)
 *
 * The Human half had the SAME defect the Agent half did, one source over: it
 * read `$.messages`, which both sync lanes cap at `MAX_METADATA_MESSAGES` (100),
 * so a session's human tail was never counted. Measured over the 27 frozen
 * golden dossiers this side reported 42 human turns against the desktop oracle's
 * 109 (2026-06-15: 2 against 9).
 *
 * ISS-5408's own remedy was unavailable here — no cloud table carries a
 * per-human-turn timestamp (`agent_session_token_events` is assistant
 * round-trips with no role column, `AgentSessionUsageRollup.humanTurns` is a
 * scalar) — so the desktop now DERIVES `metadata.humanTurnTimestamps` from its
 * full local `messages` array, using `collectHumanTurnUnits`, the same predicate
 * that feeds its own `session_turn_bucket` human rows.
 *
 * So the Human half is two disjoint per-session arms:
 * {@link humanTurnTimestampsSql} when the session carries a usable key, and
 * {@link humanTurnsSql} — the unchanged `$.messages` path — otherwise.
 * {@link hasTurnTimestampsSql} is the single expression that splits them.
 *
 * The Human and Agent halves still read INDEPENDENT sources and are guarded
 * independently, exactly as `deriveSessionTurnBuckets` does: a session with
 * round-trips but absent/malformed `$.messages` must still get its Agent cells,
 * and vice versa.
 *
 * Note the headless classifier's role NARROWS on the round-trip path, matching
 * the desktop. It used to both suppress the Human row AND promote that turn to
 * an Agent row; the promotion is moot there, because those Agent cells no longer
 * come from `$.messages` at all. The suppression half is still load-bearing.
 *
 * The promotion is NOT gone repo-wide: it survives, deliberately, on both
 * token-event-less agent arms below — folded into the derived key by the
 * desktop producer, and spelled in SQL on the raw fallback — and would
 * otherwise strand a headless session's prompts in neither half. See
 * {@link agentLegacyMessageRowsSql}.
 *
 * ## Sessions that synced no round-trip series (ISS-9864)
 *
 * Not every session has token events: the Codex OTel writer persists to
 * `token_usage` but not `token_events` (see the desktop `token-parity` note),
 * and pre-FEA-2730 rows predate the lane. Counting those as zero Agent turns
 * would render a genuinely busy period as idle — the exact failure this ticket
 * exists to prevent — so such sessions are counted from `$.messages`: assistant
 * rows PLUS, when the session is headless, its injected `human` prompts.
 *
 * That population is itself two disjoint per-session arms, the same split the
 * Human half has. `$.messages` reaches this side capped at
 * `MAX_METADATA_MESSAGES` (100), so a legacy read of it could never count turn
 * 101 — and the desktop, which stores the array whole, sliced its own read to
 * the same window so the two surfaces would at least agree (ISS-8259). ISS-7896
 * ruling A had reserved this arm's raw reading; the ISS-9864 ruling (Tamsin,
 * 2026-09-14) amended it for exactly this change. So the desktop now DERIVES
 * `metadata.agentTurnTimestamps` from its FULL local `messages` array, through
 * `collectLegacyAgentTurnUnits` — the same predicate that feeds its own
 * `session_turn_bucket` agent rows on this population — and this side reads it:
 * {@link agentTurnTimestampsSql} when the session carries a usable key, and
 * {@link agentLegacyMessageRowsSql} — the unchanged raw `$.messages` path,
 * still capped at 100 — otherwise. {@link hasTurnTimestampsSql} is the
 * single expression that splits them, and both are gated on the same
 * `NOT EXISTS (token events)` so neither can overlap {@link agentRoundTripsSql}.
 *
 * The fallback is per SESSION, applies only where the better basis is absent,
 * and is strictly the PRIOR behavior, so it can never regress a session that
 * renders correctly today. Dropping the headless term is what would regress
 * it — see {@link agentLegacyMessageRowsSql}.
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
 * ISS-7896 scoped this to sessions WITHOUT a usable `humanTurnTimestamps` — old
 * desktop builds, non-desktop callers, and any session whose producer declined to
 * carry the key. It remains the fallback basis and its own logic is untouched.
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
function humanTurnsSql(timeZone: string | undefined): Prisma.Sql {
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
    FROM scoped_sessions s
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(s.metadata -> 'messages') = 'array'
        THEN s.metadata -> 'messages'
        ELSE '[]'::jsonb
      END
    ) AS m
    WHERE NOT (${hasTurnTimestampsSql(HUMAN_TURN_TIMESTAMPS_METADATA_KEY)})
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
function agentRoundTripsSql(timeZone: string | undefined): Prisma.Sql {
  const localTs = localTsSql(Prisma.sql`te.event_created_at`, timeZone);
  return Prisma.sql`
    SELECT
      to_char(${localTs}, 'YYYY-MM-DD') AS day,
      EXTRACT(HOUR FROM ${localTs})::int AS hour,
      0 AS human,
      te.n AS agent
    FROM scoped_sessions s
    CROSS JOIN LATERAL (
      SELECT event_created_at, COUNT(*)::int AS n
      FROM agent_session_token_events
      WHERE agent_session_id = s.artifact_id
      GROUP BY event_created_at
    ) te
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
function agentLegacyMessageRowsSql(timeZone: string | undefined): Prisma.Sql {
  // ISS-9864 scoped this arm to sessions WITHOUT a usable `agentTurnTimestamps`
  // — an old desktop build, a non-desktop caller, or a producer that declined
  // to carry the key. It is the fallback basis and its row logic is untouched;
  // the desktop's TypeScript twin of this predicate now lives in
  // `@repo/lib/agent-sessions/agent-turn-timestamps` (`collectLegacyAgentTurnUnits`)
  // and is what the key on the other arm is derived from.
  //
  // ISS-8659: the fork-replay filter below is applied to BOTH surfaces in one
  // change, deliberately. ISS-8659 ruled that a fork must not be credited with
  // its parent's work, and the desktop twin is gated in the same commit. Gating
  // one side alone is what would break the ruling's actual purpose: both
  // surfaces reporting one number.
  //
  // The filter compares jsonb to jsonb rather than casting `m ->> 'isForkReplayed'`
  // to boolean. Nothing validates the element shape of this synced blob -- the
  // `messages` array has no Zod schema at cloud ingest -- so a `2`, a `{}` or a
  // string would make the cast RAISE and 500 the whole endpoint on one row, the
  // same failure the timestamp guard below already exists to prevent. `IS
  // DISTINCT FROM 'true'::jsonb` also matches the strict `=== true` the desktop
  // predicate uses, so an absent key and a junk value both mean "not replayed"
  // on either surface.
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
    FROM scoped_sessions s
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(s.metadata -> 'messages') = 'array'
        THEN s.metadata -> 'messages'
        ELSE '[]'::jsonb
      END
    ) AS m
    WHERE NOT EXISTS (
        SELECT 1
        FROM agent_session_token_events te
        WHERE te.agent_session_id = s.artifact_id
      )
      AND NOT (${hasTurnTimestampsSql(AGENT_TURN_TIMESTAMPS_METADATA_KEY)})
      AND jsonb_typeof(m) = 'object'
      AND (m -> 'isForkReplayed') IS DISTINCT FROM 'true'::jsonb
      AND (
        (m ->> 'role') = 'assistant'
        OR (
          (m ->> 'role') = 'human'
          AND COALESCE((${headlessSessionSql()}), false)
        )
      )
      AND jsonb_typeof(m -> 'timestamp') = 'string'
      AND pg_input_is_valid((m ->> 'timestamp'), 'timestamp')
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
 * Residual bound, stated so it is not mistaken for exactness. ISS-5408 freed the
 * Agent half from `MAX_METADATA_MESSAGES` (100) by reading round-trips; ISS-7896
 * freed the Human half the same way, via the desktop-derived
 * `metadata.humanTurnTimestamps`; ISS-9864 freed the token-event-less Agent
 * fallback the same way again, via `metadata.agentTurnTimestamps`. What is
 * still capped, for EITHER key:
 *
 *  - A session whose producer did NOT carry the key — an old desktop build, a
 *    non-desktop caller, or a session whose timestamps fell outside the key's
 *    grammar or past its 1000-entry bound — falls back to `$.messages` and is
 *    still bounded at 100. That is the prior number, never worse. For the agent
 *    key the bound bites harder than for the human one: an agent unit is one
 *    `$.messages` row per content BLOCK, and a token-event-less session past
 *    1000 of them reports 100 here while the desktop, which no longer slices,
 *    reports its full local count — the ISS-8259 divergence with its sign
 *    flipped, for that population only. Raising the bound is a separate ruling.
 *  - A session synced by a NEW desktop to an OLD cloud stored the key under the
 *    generic 100-item array cap. Once this side ships, that stored array is
 *    counted as-is; the session reports 100 until the desktop's revision-7
 *    replay re-syncs it. There is no cloud-side backfill.
 *  - A degraded resync (`boundSessionMetadataToBytes` shedding the appended key,
 *    `degraded-metadata-merge` reinstating the stored copy) can leave a
 *    previously capped copy in place for the same reason.
 *  - A `HEADLESS_*` list drift where THIS side classifies a session headless and
 *    the desktop producer does not: the human key then carries the injected
 *    prompts and `humanTurnTimestampsSql`'s headless guard suppresses them,
 *    while the agent key (derived non-headless) excludes them — they land in
 *    neither half. The reverse skew is fine. The raw fallback promotes them to
 *    Agent, as before.
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
        humanTurnTimestampsSql(timeZone),
        humanTurnsSql(timeZone),
        agentRoundTripsSql(timeZone),
        agentTurnTimestampsSql(timeZone),
        agentLegacyMessageRowsSql(timeZone),
      ],
      " UNION ALL "
    );
    return withDb((db) =>
      db.$queryRaw<
        { day: string; hour: number; human: number; agent: number }[]
      >(
        Prisma.sql`
          WITH scoped_sessions AS MATERIALIZED (
            SELECT s.artifact_id,
              jsonb_build_object(
                'messages', s.metadata -> 'messages',
                ${HUMAN_TURN_TIMESTAMPS_METADATA_KEY}::text,
                  s.metadata -> ${HUMAN_TURN_TIMESTAMPS_METADATA_KEY}::text,
                ${AGENT_TURN_TIMESTAMPS_METADATA_KEY}::text,
                  s.metadata -> ${AGENT_TURN_TIMESTAMPS_METADATA_KEY}::text,
                'entrypoint', s.metadata -> 'entrypoint',
                'permissionMode', s.metadata -> 'permissionMode'
              ) AS metadata
            FROM session_detail s
            JOIN artifacts a ON a.id = s.artifact_id
            WHERE s.session_started_at >= ${trendStart}
              AND s.session_started_at <= ${end}
              AND (${scopeSql})
          )
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

/**
 * Does this session carry a derived turn-timestamp ARRAY under `key` —
 * `metadata.humanTurnTimestamps` (ISS-7896) or `metadata.agentTurnTimestamps`
 * (ISS-9864)?
 *
 * ONE expression per key, used positively by the key arm
 * ({@link humanTurnTimestampsSql}, {@link agentTurnTimestampsSql}) and negated
 * by its `$.messages` fallback ({@link humanTurnsSql},
 * {@link agentLegacyMessageRowsSql}), so each pair of arms is disjoint by
 * construction rather than by two predicates someone must keep in step.
 *
 * A present array is AUTHORITATIVE, INCLUDING an empty one; only an ABSENT or
 * non-array value falls back. The producer derives each key from the very unit
 * list the desktop chart buckets (`collectHumanTurnUnits`,
 * `collectLegacyAgentTurnUnits`), so `[]` means the desktop renders that
 * session with no cells of that kind, and taking authority here is what makes
 * the two surfaces agree BY CONSTRUCTION — which is the whole point of both
 * tickets.
 *
 * The case that separates the two readings is a version skew where the producer
 * classifies a session headless and this side does not. Taking authority reports
 * 0, matching the desktop oracle. A non-empty test would instead fall back and
 * count that session's INJECTED prompts as human turns — reporting MORE human
 * activity than the oracle on a "when were people working" surface, which is the
 * misclassification `headlessSessionSql` exists to prevent. A session whose
 * timestamps fell outside the key's GRAMMAR is not this case: the producer omits
 * the key entirely there, so it lands on the fallback arm.
 *
 * `jsonb_typeof` yields NULL for absent metadata, so `COALESCE` pins that to
 * false and the negated form stays TRUE there (a NULL predicate would silently
 * drop the session from BOTH arms).
 */
function hasTurnTimestampsSql(key: string): Prisma.Sql {
  return Prisma.sql`
    COALESCE(jsonb_typeof(${turnTimestampsJsonSql(key)}) = 'array', false)
  `;
}

function turnTimestampsJsonSql(key: string): Prisma.Sql {
  return Prisma.sql`s.metadata -> ${key}::text`;
}

/** The key's array for `jsonb_array_elements`; empty where absent or not an array. */
function turnTimestampsArraySql(key: string): Prisma.Sql {
  return Prisma.sql`
    CASE
      WHEN jsonb_typeof(${turnTimestampsJsonSql(key)}) = 'array'
      THEN ${turnTimestampsJsonSql(key)}
      ELSE '[]'::jsonb
    END
  `;
}

/**
 * Human turns from `metadata.humanTurnTimestamps` — the ISS-7896 basis.
 *
 * The desktop producer derives this key from the session's FULL local `messages`
 * array before compaction, so it is the only human basis on this side that is
 * not bounded by `MAX_METADATA_MESSAGES` (100). It is whole-or-absent by
 * contract: the producer omits the key entirely rather than ship a partial list,
 * so counting it here can never report fewer turns than {@link humanTurnsSql}
 * would have.
 *
 * Element filtering mirrors that arm exactly — `jsonb_typeof(t) = 'string'` and
 * `pg_input_is_valid` — so a malformed entry drops out of the buckets instead of
 * 500-ing `/insights/utilization`. `t #>> '{}'` extracts a scalar string's text.
 *
 * The headless guard is repeated here even though the producer already excludes
 * headless sessions: the two classifications are built from the same
 * `HEADLESS_*` SSOT but they run on different machines and different versions,
 * so this side does not depend on that agreement.
 */
function humanTurnTimestampsSql(timeZone: string | undefined): Prisma.Sql {
  const localTs = localTsSql(Prisma.sql`(t #>> '{}')::timestamp`, timeZone);
  return Prisma.sql`
    SELECT
      to_char(${localTs}, 'YYYY-MM-DD') AS day,
      EXTRACT(HOUR FROM ${localTs})::int AS hour,
      1 AS human,
      0 AS agent
    FROM scoped_sessions s
    CROSS JOIN LATERAL jsonb_array_elements(
      ${turnTimestampsArraySql(HUMAN_TURN_TIMESTAMPS_METADATA_KEY)}
    ) AS t
    WHERE (${hasTurnTimestampsSql(HUMAN_TURN_TIMESTAMPS_METADATA_KEY)})
      AND jsonb_typeof(t) = 'string'
      AND pg_input_is_valid((t #>> '{}'), 'timestamp')
      AND NOT COALESCE((${headlessSessionSql()}), false)
  `;
}

/**
 * Agent turns from `metadata.agentTurnTimestamps` — the ISS-9864 basis for a
 * session that synced no round-trip series.
 *
 * The desktop producer derives this key from the session's FULL local
 * `messages` array before compaction, so it is the only token-event-less agent
 * basis on this side that is not bounded by `MAX_METADATA_MESSAGES` (100). It
 * is whole-or-absent by contract: the producer omits the key entirely rather
 * than ship a partial list, so counting it here can never report fewer turns
 * than {@link agentLegacyMessageRowsSql} would have.
 *
 * Gated on the SAME `NOT EXISTS (token events)` as the legacy arm, so a session
 * that synced round-trips is counted by {@link agentRoundTripsSql} alone even
 * if a key is present on its blob (the producer omits it there, but this side
 * does not depend on that). The three agent arms are pairwise disjoint.
 *
 * NO headless guard, unlike {@link humanTurnTimestampsSql}. The human key arm
 * re-checks headless because the two classifications can skew and the human
 * half must SUPPRESS a headless session's injected prompts; the agent key
 * INCLUDES those prompts by construction (the FEA-2641 promotion is folded into
 * the unit list on the desktop), and an entry is a bare timestamp with no role
 * to re-check. A present array is the desktop's answer, and it is taken whole.
 *
 * Element filtering mirrors the human key arm — `jsonb_typeof(t) = 'string'`
 * and `pg_input_is_valid` — so a malformed entry drops out of the buckets
 * instead of 500-ing `/insights/utilization`.
 */
function agentTurnTimestampsSql(timeZone: string | undefined): Prisma.Sql {
  const localTs = localTsSql(Prisma.sql`(t #>> '{}')::timestamp`, timeZone);
  return Prisma.sql`
    SELECT
      to_char(${localTs}, 'YYYY-MM-DD') AS day,
      EXTRACT(HOUR FROM ${localTs})::int AS hour,
      0 AS human,
      1 AS agent
    FROM scoped_sessions s
    CROSS JOIN LATERAL jsonb_array_elements(
      ${turnTimestampsArraySql(AGENT_TURN_TIMESTAMPS_METADATA_KEY)}
    ) AS t
    WHERE NOT EXISTS (
        SELECT 1
        FROM agent_session_token_events te
        WHERE te.agent_session_id = s.artifact_id
      )
      AND (${hasTurnTimestampsSql(AGENT_TURN_TIMESTAMPS_METADATA_KEY)})
      AND jsonb_typeof(t) = 'string'
      AND pg_input_is_valid((t #>> '{}'), 'timestamp')
  `;
}

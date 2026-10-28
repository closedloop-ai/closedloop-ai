/**
 * @file session-turn-bucket-equivalence.test.ts
 * @description FEA-3132 / FEA-3597 — the materialized `session_turn_bucket`
 * (built at ingest by `rebuildSessionTurnBuckets`) must reproduce an INDEPENDENT
 * SQL implementation of the same rule, BYTE-FOR-BYTE, for BOTH the activity
 * heatmap and the autonomy trend.
 *
 * The oracle below is a hand-written SQL twin — deliberately a second
 * implementation in a different language, never a call into
 * `deriveSessionTurnBuckets` (that would make this a tautology). It must be kept
 * in lock-step with the JS derivation.
 *
 * FEA-3597 moved the AGENT half. It used to read `$.messages` rows with
 * `role='assistant'` — one row per JSONL entry, so a single billable round-trip
 * split across text/tool_use/thinking blocks counted several times. It now reads
 * `$.tokenSeries` entries (the billable round-trip series). The HUMAN half is
 * unchanged.
 *
 * ISS-5395: the AGENT half counts EVERY round-trip in that series. FEA-3597
 * additionally excluded entries carrying a `subagentId`; because a folded
 * subagent has no `sessions` row of its own, that exclusion lost the turns
 * instead of re-homing them and made a delegating session read as idle.
 *
 * Edge cases pinned: tool/other roles excluded, missing-timestamp excluded,
 * non-object array elements excluded, duplicate (ts,kind) counted via
 * turn_count, headless via the `sdk-` prefix / `exec` token / bypassPermissions
 * SUPPRESSING the human row (FEA-3616: `codex_exec` and `bypassPermissions` are
 * headless; the interactive IDE transport `codex_sdk_ts` stays human),
 * subagent-attributed entries rolled up to the parent (ISS-5395), malformed
 * metadata + missing sources yielding zero rows.
 *
 * ISS-8259 added a THIRD oracle arm and is the reason the AGENT half is no
 * longer `$.tokenSeries`-only: a session that synced no round-trip series falls
 * back to `$.messages` (`role='assistant'`, plus a headless session's injected
 * `role='human'`), which is the port of the cloud's `agentLegacyMessageRowsSql`.
 * The two spellings of that predicate — this SQL twin and the desktop JS — are
 * what hold the desktop and the cloud to the same Agent count; there is no
 * shared symbol, because the cloud side is Postgres SQL over cloud-only tables.
 * Pinned here: the assistant route, the headless human PROMOTION, disjointness
 * from a populated `$.tokenSeries`, and the fallback's own exclusions (`tool`
 * role, non-headless `human`, a NUMBER timestamp, an OFFSET-bearing instant, a
 * non-object element).
 *
 * ISS-8398 moved the zone-less instant OUT of that exclusion list and into its
 * own seed: the arm now names the omitted zone as UTC and counts the row, so
 * both spellings of the predicate had to widen together. An OFFSET-bearing
 * instant is still excluded and is deliberately left in the list above — the two
 * are not two halves of one omission, and the offset case is reserved for a
 * human ruling.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { backfillSessionTurnBuckets } from "../src/main/database/session-analytics-maintenance.js";
import { rebuildSessionTurnBuckets } from "../src/main/database/turn-buckets.js";
import { openTestPrisma } from "./prisma-test-utils.js";

// The independent SQL twin. Emits one row per qualifying TURN UNIT as
// (kind, ts), which the aggregates below group exactly as the read path does.
//
// FEA-3616: headless is the shared `isHeadlessSession` predicate — entrypoint
// starts with an SDK PREFIX (`sdk-…`) OR contains an `exec` TOKEN OR
// permissionMode is `bypassPermissions`. It deliberately does NOT match the
// interactive `codex_sdk_ts` IDE transport. Kept in lock-step with
// `headlessMetadataSql` / `deriveSessionTurnBuckets`.
//
// FEA-3597 timestamp rules, and why the two halves differ:
//  - HUMAN keeps the looser VERBATIM string-or-number test. `json_type IN
//    ('text','integer','real')` is the EXACT twin of the JS
//    `typeof ts === 'string' || 'number'` guard — `IS NOT NULL` would be WRONG,
//    since a boolean or array timestamp is non-NULL to `json_extract` but
//    rejected by the JS rule.
//  - AGENT accepts only an UNAMBIGUOUS instant and stores it NORMALIZED. The
//    GLOB pins the canonical shape `toCanonicalIso` emits; `strftime` is ANDed
//    with it because GLOB alone would accept a canonical-SHAPED non-date such as
//    `2026-13-45T99:99:99.000Z`, which the JS side rejects via `Date.parse`.
//    Seeds are all canonical, so the normalization is the identity here and the
//    raw value can be compared directly; non-canonical normalization is asserted
//    in session-turn-bucket-derive.test.ts, where JS runs on both sides.
const turnsOracle = (ph: string) =>
  `SELECT 'human' AS kind, json_extract(m.value,'$.timestamp') AS ts
   FROM sessions s
   JOIN json_each(CASE WHEN json_valid(s.metadata)
                       THEN CASE WHEN json_type(s.metadata,'$.messages')='array'
                                 THEN s.metadata END END, '$.messages') m
   WHERE s.id IN (${ph})
     AND m.type='object'
     AND json_extract(m.value,'$.role')='human'
     AND json_type(m.value,'$.timestamp') IN ('text','integer','real')
     -- COALESCE every extraction: an absent entrypoint/permissionMode yields
     -- SQL NULL, and NULL propagates through OR so the whole predicate becomes
     -- NULL and NOT NULL filters the row out entirely — silently dropping human
     -- rows for any session that simply has no permissionMode.
     AND NOT (CASE WHEN json_valid(s.metadata) THEN
                COALESCE(lower(json_extract(s.metadata,'$.entrypoint')),'') LIKE 'sdk-%'
                OR COALESCE(lower(json_extract(s.metadata,'$.entrypoint')),'') LIKE '%exec%'
                OR COALESCE(json_extract(s.metadata,'$.permissionMode'),'') = 'bypassPermissions'
              ELSE 0 END)
   UNION ALL
   SELECT 'agent' AS kind, json_extract(t.value,'$.timestamp') AS ts
   FROM sessions s
   JOIN json_each(CASE WHEN json_valid(s.metadata)
                       THEN CASE WHEN json_type(s.metadata,'$.tokenSeries')='array'
                                 THEN s.metadata END END, '$.tokenSeries') t
   WHERE s.id IN (${ph})
     -- ISS-8259 review (davetho): the agent half picks ONE basis, on the SAME
     -- condition the cloud splits on — token-event presence. This arm is the
     -- round-trip side of that if/else, so it is gated too; leaving it
     -- unconditional is what let a series-bearing session with no token events
     -- read its series here while the cloud read its messages.
     AND EXISTS (
       SELECT 1 FROM token_events te WHERE te.session_id = s.id
     )
     AND t.type='object'
     AND json_extract(t.value,'$.timestamp') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
     AND strftime('%Y-%m-%d', json_extract(t.value,'$.timestamp')) IS NOT NULL
   UNION ALL
   SELECT 'agent' AS kind, json_extract(m.value,'$.timestamp') AS ts
   FROM sessions s
   JOIN json_each(CASE WHEN json_valid(s.metadata)
                       THEN CASE WHEN json_type(s.metadata,'$.messages')='array'
                                 THEN s.metadata END END, '$.messages') m
   WHERE s.id IN (${ph})
     -- ISS-8259 disjointness, and it is now ONE condition, not two.
     -- token_events is the twin of the cloud's NOT EXISTS against
     -- agent_session_token_events — the table that actually syncs — and it is
     -- the exact complement of the EXISTS on the round-trip arm above, so the
     -- two arms partition every session and double-counting is structural
     -- rather than conditional. The empty-tokenSeries clause that used to sit
     -- here was removed with its counterpart in the derivation: it made this
     -- arm skip a session the cloud counts from its messages.
     AND NOT EXISTS (
       SELECT 1 FROM token_events te WHERE te.session_id = s.id
     )
     AND m.type='object'
     AND (
       json_extract(m.value,'$.role')='assistant'
       OR (json_extract(m.value,'$.role')='human'
           AND (CASE WHEN json_valid(s.metadata) THEN
                  COALESCE(lower(json_extract(s.metadata,'$.entrypoint')),'') LIKE 'sdk-%'
                  OR COALESCE(lower(json_extract(s.metadata,'$.entrypoint')),'') LIKE '%exec%'
                  OR COALESCE(json_extract(s.metadata,'$.permissionMode'),'') = 'bypassPermissions'
                ELSE 0 END))
     )
     -- 'text' ONLY, never integer/real: this arm mirrors the cloud's
     -- jsonb_typeof(m -> 'timestamp') = 'string'. Only the human arm above takes
     -- a number, and only because FEA-3597 froze its output byte-identical.
     AND json_type(m.value,'$.timestamp') = 'text'
     -- ISS-8259: an OFFSET-bearing instant is rejected on this arm only. Both
     -- surfaces accept it and then disagree — PostgreSQL's cast to a zone-less
     -- timestamp DISCARDS the offset while toCanonicalIso converts it — so
     -- counting it would put one turn on two different days. Neither GLOB below
     -- admits the spelling; this comment is why neither may be loosened into one
     -- that would.
     --
     -- ISS-8398 AMENDED the standing requirement that used to sit here, so it is
     -- restated rather than deleted. It read: any seed reaching this arm must
     -- spell its timestamp canonically, because the store holds
     -- toCanonicalIso(ts) while this oracle compares the RAW value. That is
     -- still true of every spelling but ONE. The zone-less form is now counted
     -- by the derivation and stored canonically (...T09:02:00 becomes
     -- ...T09:02:00.000Z), so the raw text and the stored text genuinely differ.
     -- The comparison still holds because this oracle never compares the text.
     -- It compares the day and hour SQLite derives from it, and SQLite
     -- reads a zone-less date-time and a Z-suffixed one as the same UTC instant
     -- (verified directly: strftime over the two spellings agrees under both UTC
     -- and 'localtime'). No OTHER non-canonical spelling has been admitted, so a
     -- no-millis ...T10:00:00Z seed would still be dropped here and surface as a
     -- phantom disagreement. derive.test.ts owns normalization.
     --
     -- The GLOBs are separate FULL patterns ORed together, never one loosened
     -- pattern. A pattern relaxed enough to admit the zone-less forms (say, by
     -- dropping the trailing .[0-9][0-9][0-9]Z run, or by ending in *) would
     -- also admit the 2026-07-06T09:03:00+02:00 seed below, silently reversing
     -- the offset ruling this ticket reserves for a human. Every pattern here
     -- is exact-length, so no offset form can satisfy one: verified that each
     -- of the four rejects both 2026-07-06T09:03:00+02:00 and its fractional
     -- spelling.
     --
     -- There are FOUR because ISS-8398 admits THREE zone-less spellings, not
     -- one. readZoneLessAsUtc names the zone of anything matching
     -- YYYY-MM-DDT[digits : .]+, so exact-second, minute-only and fractional
     -- forms all reach the arm, and each gets its own seed below. A twin that
     -- covered only the exact-second form would leave two thirds of the
     -- widening cross-checked by nothing but the unit suite.
     --
     -- A fractional form with MORE than one digit is admitted by production but
     -- NOT by these patterns, because GLOB cannot express "one or more digits"
     -- without a trailing * that would readmit the offset forms. That narrowing
     -- is deliberate and seed-visible: no such seed exists, so the arms cannot
     -- disagree over one. session-turn-bucket-zone-less-instant.test.ts owns
     -- that spelling.
     AND (
       json_extract(m.value,'$.timestamp') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
       OR json_extract(m.value,'$.timestamp') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]'
       OR json_extract(m.value,'$.timestamp') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'
       OR json_extract(m.value,'$.timestamp') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9]'
     )
     AND strftime('%Y-%m-%d', json_extract(m.value,'$.timestamp')) IS NOT NULL
     -- ISS-8398: does the DAY exist? Normalizing ONLY the date part and
     -- comparing it to the text it came from is the independent SQL expression
     -- of namesARealCalendarDay: SQLite rolls 2026-02-30 to 2026-03-02 exactly
     -- as Date.parse does, so the two arms drop the same rows. Deliberately
     -- narrow — the FULL string normalized and compared would also reject
     -- 2026-06-03T24:00:00Z, a legal end-of-day both Postgres and the JS arm
     -- count.
     AND strftime('%Y-%m-%d', substr(json_extract(m.value,'$.timestamp'),1,10))
         = substr(json_extract(m.value,'$.timestamp'),1,10)
     -- ISS-8398: and does the YEAR exist? PostgreSQL's proleptic calendar runs
     -- 1 BC -> 1 AD with no year 0, so it refuses a 0000-… row that both JS
     -- Date and SQLite happily represent — the day check above cannot see this
     -- because 0000-01-01 IS a well-formed day in both. A plain text compare
     -- rather than another strftime, so the oracle stays independent of
     -- whatever SQLite chooses to do with year zero. Only 0 is excluded: years
     -- 1-99 are valid Postgres timestamps and are counted by both surfaces.
     AND substr(json_extract(m.value,'$.timestamp'),1,4) <> '0000'`;

type Seed = {
  id: string;
  entrypoint: string;
  permissionMode?: string;
  messages?: unknown[];
  tokenSeries?: unknown[];
  metadataRaw?: string;
  /** ISS-8259: seed a real `token_events` row at this instant for this session. */
  tokenEvent?: string;
};

/** A canonical parent token record (FEA-3597: no `subagentId` ⇒ parent). */
const tok = (timestamp: string, extra: Record<string, unknown> = {}) => ({
  timestamp,
  model: "m",
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  ...extra,
});

const SEEDS: Seed[] = [
  {
    id: "s-cli",
    entrypoint: "cli",
    messages: [
      { role: "human", timestamp: "2026-07-01T10:15:00Z" },
      // FEA-3597: assistant MESSAGES are no longer an agent source — these are
      // the per-block over-count the ticket removes and must contribute nothing.
      { role: "assistant", timestamp: "2026-07-01T10:16:00Z" },
      { role: "assistant", timestamp: "2026-07-01T10:16:00Z" },
      { role: "tool", timestamp: "2026-07-01T10:17:00Z" }, // excluded (role)
      { role: "human" }, // excluded (no ts)
      "a-string-primitive", // excluded (non-object)
    ],
    tokenSeries: [
      tok("2026-07-01T10:16:00.000Z"),
      tok("2026-07-01T10:16:00.000Z"), // dup (ts,kind) -> turn_count 2
      // ISS-5395: a folded subagent round-trip IS an agent turn on the parent's
      // timeline — the child has no session row of its own to carry it.
      tok("2026-07-01T10:18:00.000Z", { subagentId: "agent-abc" }),
      "a-string-primitive", // excluded (non-object)
      { model: "m" }, // excluded (no ts)
    ],
  },
  {
    id: "s-sdk",
    entrypoint: "sdk-ts", // headless -> the human turn yields NO human row
    messages: [
      { role: "human", timestamp: "2026-07-02T09:00:00Z" },
      { role: "assistant", timestamp: "2026-07-02T09:05:00Z" },
    ],
    tokenSeries: [tok("2026-07-02T09:05:00.000Z")],
  },
  {
    id: "s-exec",
    entrypoint: "some-exec-runner", // '%exec%' -> headless
    messages: [{ role: "human", timestamp: "2026-07-02T14:00:00Z" }],
    tokenSeries: [tok("2026-07-02T14:01:00.000Z")],
  },
  {
    // FEA-3616: codex exec originator -> '%exec%' -> headless.
    id: "s-codex-exec",
    entrypoint: "codex_exec",
    messages: [{ role: "human", timestamp: "2026-07-03T09:00:00Z" }],
    tokenSeries: [tok("2026-07-03T09:01:00.000Z")],
  },
  {
    // FEA-3616 GUARD: `codex_sdk_ts` is the Codex VS Code / Conductor IDE
    // transport — it carries `sdk` but is a HUMAN typing in the IDE (golden
    // f04610b7 / 8bbdbfab). It is NOT `sdk-`-prefixed, so it stays interactive.
    id: "s-codex-ide",
    entrypoint: "codex_sdk_ts",
    messages: [{ role: "human", timestamp: "2026-07-03T08:00:00Z" }],
  },
  {
    // FEA-3616: interactive entrypoint launched with skip-permissions automation
    // -> headless via permissionMode. ISS-8259: this seed carries no
    // tokenSeries, so it now also takes the legacy `$.messages` arm and its
    // prompt is PROMOTED to agent — hence the canonical timestamp (see the
    // oracle's third arm; the agent half stores `toCanonicalIso(ts)`).
    id: "s-bypass",
    entrypoint: "cli",
    permissionMode: "bypassPermissions",
    messages: [{ role: "human", timestamp: "2026-07-03T10:00:00.000Z" }],
  },
  {
    // Control: a genuine interactive human session still counts as human.
    id: "s-human",
    entrypoint: "cli",
    permissionMode: "default",
    messages: [{ role: "human", timestamp: "2026-07-03T11:00:00Z" }],
  },
  {
    // ISS-8259 (was FEA-3597 ruling §6 case 1, EXPECTATION CHANGED BY THIS
    // TICKET): messages present, tokenSeries EMPTY. FEA-3597 pinned 0 agent
    // rows here; the desktop therefore reported a token-event-less session as
    // idle while the cloud's `agentLegacyMessageRowsSql` counted its assistant
    // rows, which is the cross-surface fork this ticket closes. The assistant
    // row now yields ONE agent row. The human row is unaffected. Assistant
    // messages are still NOT an agent source when tokenSeries IS populated —
    // `s-cli` above is the seed that pins FEA-3597's actual over-count fix.
    //
    // Timestamps are canonical here (unlike the pre-ISS-8259 seed) because the
    // agent half stores `toCanonicalIso(ts)` while this oracle compares the raw
    // value; the file header's "seeds are all canonical" convention now binds
    // the message-fallback arm too. Non-canonical normalization is asserted in
    // session-turn-bucket-derive.test.ts, where JS runs on both sides.
    id: "s-no-series",
    entrypoint: "cli",
    messages: [
      { role: "human", timestamp: "2026-07-04T10:00:00.000Z" },
      { role: "assistant", timestamp: "2026-07-04T10:01:00.000Z" },
    ],
    tokenSeries: [],
  },
  {
    // ISS-8259 — the golden 8998f3ad shape: headless (`codex_exec`) AND no
    // round-trip series. The assistant row counts as Agent, and the injected
    // `human` prompt is PROMOTED to Agent rather than stranded: `collectHumanUnits`
    // suppresses it on the human side, so dropping the promotion would count it
    // in neither half and blank a day whose only activity was a `codex exec` run.
    id: "s-legacy-headless",
    entrypoint: "codex_exec",
    messages: [
      { role: "assistant", timestamp: "2026-07-05T09:00:00.000Z" },
      { role: "human", timestamp: "2026-07-05T09:00:01.000Z" },
    ],
    tokenSeries: [],
  },
  {
    // ISS-8259 — the fallback's own exclusions, all on a no-series session:
    // a `tool` role, a `human` role on a NON-headless session (it stays Human),
    // a NUMBER timestamp (the cloud requires jsonb string), an OFFSET-bearing
    // instant, and a non-object element.
    //
    // ISS-8398 REMOVED the zone-less `2026-07-06T09:02:00` from this seed — it
    // is counted now, and lives in `s-legacy-zoneless` below. The OFFSET-bearing
    // row stays here deliberately: it is the case both surfaces accept and
    // bucket on different DAYS, and choosing a day for it is a cross-surface
    // product decision reserved for a human.
    id: "s-legacy-excluded",
    entrypoint: "cli",
    messages: [
      { role: "tool", timestamp: "2026-07-06T09:00:00.000Z" },
      { role: "assistant", timestamp: 1_781_000_000_000 },
      { role: "assistant", timestamp: "2026-07-06T09:03:00+02:00" },
      { role: "assistant" },
      "a-string-primitive",
    ],
    tokenSeries: [],
  },
  {
    // ISS-8398 — a ZONE-LESS assistant instant on a no-series session, the one
    // spelling this ticket added. Both spellings of the predicate must agree on
    // it, which is the whole point of this seed: the store holds
    // `2026-07-06T09:02:00.000Z` (toCanonicalIso named the omitted zone as UTC)
    // while the oracle GLOBs the RAW `2026-07-06T09:02:00`, and the two still
    // reconcile because SQLite reads both spellings as the same UTC instant.
    id: "s-legacy-zoneless",
    entrypoint: "cli",
    messages: [{ role: "assistant", timestamp: "2026-07-06T09:02:00" }],
    tokenSeries: [],
  },
  {
    // ISS-8398 — the MINUTE-ONLY zone-less spelling. `readZoneLessAsUtc` admits
    // it, so the arm counts it at 09:04:00Z; the store holds the canonical form
    // and the oracle GLOBs the raw 16-character text.
    id: "s-legacy-zoneless-minute",
    entrypoint: "cli",
    messages: [{ role: "assistant", timestamp: "2026-07-06T09:04" }],
    tokenSeries: [],
  },
  {
    // ISS-8398 — the FRACTIONAL zone-less spelling, counted at 09:05:00.500Z.
    // The three zone-less seeds together are what make the twin cover the whole
    // widening rather than its most obvious third.
    id: "s-legacy-zoneless-frac",
    entrypoint: "cli",
    messages: [{ role: "assistant", timestamp: "2026-07-06T09:05:00.5" }],
    tokenSeries: [],
  },
  {
    // ISS-8398 — a day that does not exist. Date.parse rolls it to March 2 and
    // SQLite rolls it the same way, so without the day check BOTH arms would
    // count it, agree with each other, and disagree with PostgreSQL, which
    // refuses the row. Seeded so the two arms are held to dropping it rather
    // than to matching each other's roll-over.
    id: "s-legacy-impossible-day",
    entrypoint: "cli",
    messages: [{ role: "assistant", timestamp: "2026-02-30T00:30:00.000Z" }],
    tokenSeries: [],
  },
  {
    // ISS-8398 — a year that does not exist. PostgreSQL's proleptic calendar
    // has no year 0, so pg_input_is_valid refuses this row (verified live),
    // while JS Date and SQLite both represent it and the DAY check above sees
    // nothing wrong with it. Same standard as the impossible-day seed: the two
    // arms are held to dropping it, not to agreeing with each other against the
    // cloud. Years 1-99 are valid there and stay counted — the JS side pins
    // 0050 for exactly that edge.
    id: "s-legacy-year-zero",
    entrypoint: "cli",
    messages: [{ role: "assistant", timestamp: "0000-01-01T00:30:00.000Z" }],
    tokenSeries: [],
  },
  {
    // ISS-8259 — the SYNTHESIZED-token-events shape, and the reason the gate
    // needs a `token_events` read and not just an empty-series check. When
    // `$.tokenSeries` is empty but `$.tokensByModel` is not,
    // `import-session-context.ts` synthesizes one token event per model; those
    // rows sync, so the CLOUD holds token events and takes its round-trip arm
    // rather than its `$.messages` fallback. `tokensByModel` is NOT persisted
    // into `metadata`, so this seed carries the real `token_events` row (see
    // `tokenEventSessions` below) — a metadata-only gate cannot see it and would
    // count the assistant row here, over-counting against the cloud.
    id: "s-synth-events",
    entrypoint: "cli",
    messages: [{ role: "assistant", timestamp: "2026-07-07T09:00:00.000Z" }],
    tokenSeries: [],
    tokenEvent: "2026-07-07T09:00:00.000Z",
  },
  {
    // FEA-3597: tokenSeries populated, $.messages ABSENT -> agent rows STILL
    // produced. The `messages` guard must gate only the human half.
    id: "s-no-messages",
    entrypoint: "cli",
    tokenSeries: [tok("2026-07-04T11:00:00.000Z")],
  },
  { id: "s-malformed", entrypoint: "cli", metadataRaw: "{not valid json" },
  { id: "s-nomsgs", entrypoint: "cli" },
];

function norm(rows: Record<string, unknown>[], keys: string[]) {
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const k of keys) {
      o[k] = k === "day" ? r[k] : Number(r[k]);
    }
    return o;
  });
}

test("session_turn_bucket read == independent SQL oracle (heatmap + autonomy)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await prisma.write(async (client) => {
      for (const s of SEEDS) {
        const metadata =
          s.metadataRaw ??
          JSON.stringify({
            entrypoint: s.entrypoint,
            ...(s.permissionMode === undefined
              ? {}
              : { permissionMode: s.permissionMode }),
            ...(s.messages === undefined ? {} : { messages: s.messages }),
            ...(s.tokenSeries === undefined
              ? {}
              : { tokenSeries: s.tokenSeries }),
          });
        await client.$executeRawUnsafe(
          "INSERT INTO sessions (id, status, started_at, ended_at, metadata) VALUES ($1,$2,$3,$4,$5)",
          s.id,
          "completed",
          "2026-07-01T00:00:00Z",
          "2026-07-01T01:00:00Z",
          metadata
        );
        // The importer writes ONE `token_events` row per `$.tokenSeries` entry
        // (`import-session-context.ts`: `tokenSeries.length > 0 ? tokenSeries :
        // <synthesized>`), so a series-bearing seed must carry them or it is
        // describing a store the importer cannot produce. Deriving them here
        // rather than listing them per seed is what stops the two from drifting
        // as seeds are added. `tokenEvent` remains an explicit override for the
        // SYNTHESIZED shape, where the series is empty and the row exists anyway.
        const tokenEventInstants =
          s.tokenEvent === undefined
            ? (s.tokenSeries ?? []).flatMap((entry) =>
                typeof entry === "object" &&
                entry !== null &&
                typeof (entry as { timestamp?: unknown }).timestamp === "string"
                  ? [(entry as { timestamp: string }).timestamp]
                  : []
              )
            : [s.tokenEvent];
        for (const instant of tokenEventInstants) {
          await client.$executeRawUnsafe(
            `INSERT INTO token_events
               (session_id, model, created_at, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens)
             VALUES ($1,$2,$3,1,1,0,0)`,
            s.id,
            "m",
            instant
          );
        }
      }
    });
    const ids = SEEDS.map((s) => s.id);
    await prisma.write((client) =>
      client.$transaction((tx) => rebuildSessionTurnBuckets(tx, ids))
    );

    const ph = ids.map(() => "?").join(",");
    const WSTART = "2020-01-01T00:00:00Z";
    const WEND = "2030-01-01T00:00:00Z";
    // The oracle names each id once per UNION arm: human, tokenSeries agent,
    // and (ISS-8259) legacy `$.messages` agent.
    const oracleParams = [...ids, ...ids, ...ids];

    // Heatmap: independent oracle vs the materialized table.
    const oldHeatmap = await prisma.read((r) =>
      r.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT strftime('%Y-%m-%d',t.ts,'localtime') AS day,
                CAST(strftime('%H',t.ts,'localtime') AS INTEGER) AS hour,
                COUNT(*) FILTER (WHERE t.kind='human') AS human,
                COUNT(*) FILTER (WHERE t.kind='agent') AS agent
         FROM (${turnsOracle(ph)}) t
         WHERE t.ts IS NOT NULL
         GROUP BY day,hour HAVING day IS NOT NULL ORDER BY day,hour`,
        ...oracleParams
      )
    );
    const newHeatmap = await prisma.read((r) =>
      r.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT strftime('%Y-%m-%d',b.ts,'localtime') AS day,
                CAST(strftime('%H',b.ts,'localtime') AS INTEGER) AS hour,
                SUM(CASE WHEN b.turn_kind='human' THEN b.turn_count ELSE 0 END) AS human,
                SUM(CASE WHEN b.turn_kind='agent' THEN b.turn_count ELSE 0 END) AS agent
         FROM session_turn_bucket b JOIN sessions s ON s.id=b.session_id
         WHERE s.started_at IS NOT NULL AND s.started_at BETWEEN ? AND ?
         GROUP BY day,hour HAVING day IS NOT NULL ORDER BY day,hour`,
        WSTART,
        WEND
      )
    );
    const hkeys = ["day", "hour", "human", "agent"];
    assert.deepEqual(norm(newHeatmap, hkeys), norm(oldHeatmap, hkeys));
    assert.ok(oldHeatmap.length > 0, "expected some heatmap cells");

    // Autonomy: independent oracle vs the materialized table.
    const oldAuto = await prisma.read((r) =>
      r.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT strftime('%Y-%m-%d',t.ts,'localtime') AS day,
                COUNT(*) FILTER (WHERE t.kind='agent') AS agent,
                COUNT(*) AS total
         FROM (${turnsOracle(ph)}) t
         WHERE t.ts IS NOT NULL
         GROUP BY day HAVING day IS NOT NULL ORDER BY day`,
        ...oracleParams
      )
    );
    const newAuto = await prisma.read((r) =>
      r.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT strftime('%Y-%m-%d',b.ts,'localtime') AS day,
                SUM(CASE WHEN b.turn_kind='agent' THEN b.turn_count ELSE 0 END) AS agent,
                SUM(b.turn_count) AS total
         FROM session_turn_bucket b JOIN sessions s ON s.id=b.session_id
         WHERE s.started_at IS NOT NULL AND s.started_at BETWEEN ? AND ?
         GROUP BY day HAVING day IS NOT NULL ORDER BY day`,
        WSTART,
        WEND
      )
    );
    const akeys = ["day", "agent", "total"];
    assert.deepEqual(norm(newAuto, akeys), norm(oldAuto, akeys));

    // Idempotency: rebuilding again yields the same buckets (DELETE-then-INSERT).
    await prisma.write((client) =>
      client.$transaction((tx) => rebuildSessionTurnBuckets(tx, ids))
    );
    const [{ c }] = await prisma.read((r) =>
      r.$queryRawUnsafe<{ c: number }[]>(
        "SELECT COUNT(*) AS c FROM session_turn_bucket"
      )
    );
    // FEA-3597 row arithmetic, as corrected by ISS-5395 (rows, not units) and
    // extended by ISS-8259. A session with a POPULATED tokenSeries is untouched
    // by this ticket; only the four no-series seeds move.
    //   s-cli:         1 human@10:15 + 1 agent@10:16 (count 2)
    //                  + 1 agent@10:18 (the folded subagent's round-trip,
    //                  which ISS-5395 rolls up onto the parent rather than
    //                  dropping — its own distinct ts, so its own row) = 3
    //   s-sdk:         headless -> no human row; 1 agent@09:05      = 1
    //   s-exec:        headless -> no human row; 1 agent@14:01      = 1
    //   s-codex-exec:  headless -> no human row; 1 agent@09:01      = 1
    //   s-codex-ide:   interactive -> 1 human@08:00; no tokenSeries,
    //                  and a non-headless human is NOT promoted      = 1
    //   s-bypass:      headless -> no human row; no tokenSeries, so
    //                  ISS-8259 promotes the prompt: 1 agent@10:00   = 1
    //   s-human:       1 human@11:00                                = 1
    //   s-no-series:   1 human@10:00 + ISS-8259 1 agent@10:01       = 2
    //   s-legacy-headless: headless, no series -> 1 agent@09:00
    //                  (assistant) + 1 agent@09:00:01 (promoted)     = 2
    //   s-legacy-excluded: every element fails a fallback guard      = 0
    //                  (incl. the OFFSET-bearing instant, which both surfaces
    //                  accept and bucket on DIFFERENT days — see the oracle)
    //   s-legacy-zoneless: ISS-8398 — the zone-less instant is now READ as
    //                  UTC rather than rejected: 1 agent@09:02Z          = 1
    //   s-legacy-zoneless-minute: the minute-only spelling, 1 agent@09:04Z = 1
    //   s-legacy-zoneless-frac:   the fractional spelling, 1 agent@09:05Z  = 1
    //   s-legacy-impossible-day: the day does not exist, both arms drop it = 0
    //   s-synth-events: a real token_events row -> gate closed        = 0
    //   s-no-messages: no messages -> 0 human; 1 agent@11:00        = 1
    //   s-malformed / s-nomsgs:                                     = 0
    //   TOTAL = 3+1+1+1+1+1+1+2+2+0+1+1+1+0+1+0 = 17
    assert.equal(Number(c), 17);
  } finally {
    await close();
  }
});

test("backfill is race-free: ingest populating one session does not strand the rest", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Two historical sessions with human/assistant turns.
    await prisma.write(async (client) => {
      for (const id of ["old-a", "old-b"]) {
        await client.$executeRawUnsafe(
          "INSERT INTO sessions (id, status, started_at, ended_at, metadata) VALUES ($1,$2,$3,$4,$5)",
          id,
          "completed",
          "2026-07-01T00:00:00Z",
          "2026-07-01T01:00:00Z",
          JSON.stringify({
            entrypoint: "cli",
            messages: [{ role: "human", timestamp: "2026-07-01T10:00:00Z" }],
          })
        );
      }
    });

    // Simulate a live ingest winning the race against boot backfill: it rolls up
    // only old-a, populating that session's buckets before backfill runs. A
    // whole-table COUNT>0 gate would now skip backfill entirely and strand old-b.
    await prisma.write((client) =>
      client.$transaction((tx) => rebuildSessionTurnBuckets(tx, ["old-a"]))
    );
    const before = await prisma.read((r) =>
      r.$queryRawUnsafe<{ session_id: string }[]>(
        "SELECT DISTINCT session_id FROM session_turn_bucket ORDER BY session_id"
      )
    );
    assert.deepEqual(
      before.map((b) => b.session_id),
      ["old-a"]
    );

    await backfillSessionTurnBuckets(prisma, () => undefined);

    // old-b must now be backfilled despite old-a already being present.
    const after = await prisma.read((r) =>
      r.$queryRawUnsafe<{ session_id: string }[]>(
        "SELECT DISTINCT session_id FROM session_turn_bucket ORDER BY session_id"
      )
    );
    assert.deepEqual(
      after.map((b) => b.session_id),
      ["old-a", "old-b"]
    );
  } finally {
    await close();
  }
});

test("ISS-5395: a still-open session keeps accruing buckets across incremental imports", async () => {
  // Mechanism (B) from the ticket: if bucket derivation only ran on a completed
  // or newly-DISCOVERED session, a long-lived transcript that keeps growing
  // would freeze at its first import and the chart would report a busy day as
  // idle. The session stays `active` (never ended) across all three passes, and
  // the parent's own work stops after pass 1 so every later turn arrives via a
  // sub-agent — the exact shape that vanished before this fix.
  const { prisma, close } = await openTestPrisma();
  try {
    const id = "long-lived";
    const series: Record<string, unknown>[] = [
      tok("2026-08-05T02:36:50.140Z"),
      tok("2026-08-05T02:40:00.000Z"),
    ];
    const writeMetadata = async () => {
      await prisma.write((client) =>
        client.$executeRawUnsafe(
          `INSERT INTO sessions (id, status, started_at, metadata) VALUES ($1,$2,$3,$4)
           ON CONFLICT(id) DO UPDATE SET metadata = excluded.metadata`,
          id,
          "active",
          "2026-08-05T02:36:35.365Z",
          JSON.stringify({
            entrypoint: "cli",
            messages: [],
            tokenSeries: series,
          })
        )
      );
      // A re-import rewrites the token_events rows from the series, so the
      // fixture does too: the importer writes one row per entry, and ISS-8259
      // made the agent half read that table to choose its basis. Without this
      // the seed is a partial store, and the round-trip arm it means to exercise
      // would never run.
      await prisma.write(async (client) => {
        await client.$executeRawUnsafe(
          "DELETE FROM token_events WHERE session_id = $1",
          id
        );
        for (const entry of series) {
          await client.$executeRawUnsafe(
            `INSERT INTO token_events
               (session_id, model, created_at, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens)
             VALUES ($1,$2,$3,1,1,0,0)`,
            id,
            "m",
            (entry as { timestamp: string }).timestamp
          );
        }
      });
      await prisma.write((client) =>
        client.$transaction((tx) => rebuildSessionTurnBuckets(tx, [id]))
      );
    };
    const agentTotal = async (): Promise<number> => {
      const [row] = await prisma.read((r) =>
        r.$queryRawUnsafe<{ n: number | bigint | null }[]>(
          "SELECT SUM(turn_count) AS n FROM session_turn_bucket WHERE session_id = $1 AND turn_kind = 'agent'",
          id
        )
      );
      return Number(row?.n ?? 0);
    };

    await writeMetadata();
    assert.equal(
      await agentTotal(),
      2,
      "first import materializes the buckets"
    );

    // Pass 2: the transcript grows, and every new round-trip is a sub-agent's.
    series.push(
      tok("2026-08-05T14:21:40.159Z", { subagentId: "agent-a" }),
      tok("2026-08-05T14:25:00.000Z", { subagentId: "agent-b" })
    );
    await writeMetadata();
    assert.equal(
      await agentTotal(),
      4,
      "a re-import of a still-open session must pick up the new round-trips"
    );

    // Pass 3: a second day of delegated work on the SAME open session.
    series.push(
      tok("2026-08-06T09:00:00.000Z", { subagentId: "agent-a" }),
      tok("2026-08-06T09:05:00.000Z", { subagentId: "agent-c" }),
      tok("2026-08-06T09:10:00.000Z", { subagentId: "agent-c" })
    );
    await writeMetadata();
    assert.equal(await agentTotal(), 7);

    // The regression guard the ticket asked for: turns on day 1 AND continued
    // activity on day 2 must yield buckets on BOTH days, never a single-day
    // record that reads as "started, then went idle".
    const days = await prisma.read((r) =>
      r.$queryRawUnsafe<{ day: string; n: number | bigint }[]>(
        `SELECT substr(ts,1,10) AS day, SUM(turn_count) AS n
         FROM session_turn_bucket WHERE session_id = $1 AND turn_kind = 'agent'
         GROUP BY day ORDER BY day`,
        id
      )
    );
    assert.deepEqual(
      days.map((d) => [d.day, Number(d.n)]),
      [
        ["2026-08-05", 4],
        ["2026-08-06", 3],
      ]
    );
  } finally {
    await close();
  }
});

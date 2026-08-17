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
 */
import assert from "node:assert/strict";
import { test } from "node:test";
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
     AND t.type='object'
     AND json_extract(t.value,'$.timestamp') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
     AND strftime('%Y-%m-%d', json_extract(t.value,'$.timestamp')) IS NOT NULL`;

type Seed = {
  id: string;
  entrypoint: string;
  permissionMode?: string;
  messages?: unknown[];
  tokenSeries?: unknown[];
  metadataRaw?: string;
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
    // 019effc3 / 019f0041). It is NOT `sdk-`-prefixed, so it stays interactive.
    id: "s-codex-ide",
    entrypoint: "codex_sdk_ts",
    messages: [{ role: "human", timestamp: "2026-07-03T08:00:00Z" }],
  },
  {
    // FEA-3616: interactive entrypoint launched with skip-permissions automation
    // -> headless via permissionMode.
    id: "s-bypass",
    entrypoint: "cli",
    permissionMode: "bypassPermissions",
    messages: [{ role: "human", timestamp: "2026-07-03T10:00:00Z" }],
  },
  {
    // Control: a genuine interactive human session still counts as human.
    id: "s-human",
    entrypoint: "cli",
    permissionMode: "default",
    messages: [{ role: "human", timestamp: "2026-07-03T11:00:00Z" }],
  },
  {
    // FEA-3597: messages present, tokenSeries EMPTY -> 0 agent rows (ruling §6
    // case 1). The human row is unaffected.
    id: "s-no-series",
    entrypoint: "cli",
    messages: [
      { role: "human", timestamp: "2026-07-04T10:00:00Z" },
      { role: "assistant", timestamp: "2026-07-04T10:01:00Z" },
    ],
    tokenSeries: [],
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
      }
    });
    const ids = SEEDS.map((s) => s.id);
    await prisma.write((client) =>
      client.$transaction((tx) => rebuildSessionTurnBuckets(tx, ids))
    );

    const ph = ids.map(() => "?").join(",");
    const WSTART = "2020-01-01T00:00:00Z";
    const WEND = "2030-01-01T00:00:00Z";
    // The oracle names each id twice (once per UNION arm).
    const oracleParams = [...ids, ...ids];

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
    // FEA-3597 row arithmetic, as corrected by ISS-5395 (rows, not units):
    //   s-cli:         1 human@10:15 + 1 agent@10:16 (count 2)
    //                  + 1 agent@10:18 (the folded subagent's round-trip,
    //                  which ISS-5395 rolls up onto the parent rather than
    //                  dropping — its own distinct ts, so its own row) = 3
    //   s-sdk:         headless -> no human row; 1 agent@09:05      = 1
    //   s-exec:        headless -> no human row; 1 agent@14:01      = 1
    //   s-codex-exec:  headless -> no human row; 1 agent@09:01      = 1
    //   s-codex-ide:   interactive -> 1 human@08:00; no tokenSeries = 1
    //   s-bypass:      headless -> no human row; no tokenSeries     = 0
    //   s-human:       1 human@11:00                                = 1
    //   s-no-series:   1 human@10:00; empty tokenSeries -> 0 agent  = 1
    //   s-no-messages: no messages -> 0 human; 1 agent@11:00        = 1
    //   s-malformed / s-nomsgs:                                     = 0
    //   TOTAL = 3+1+1+1+1+0+1+1+1 = 10
    assert.equal(Number(c), 10);
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

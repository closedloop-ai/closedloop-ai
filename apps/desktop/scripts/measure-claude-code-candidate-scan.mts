/**
 * ISS-11323 — measure the Claude Code candidate scan at ISS-7352 scale.
 *
 * Builds a fixture at the scale ISS-7352 actually recorded — 32,930
 * `claude_code_cost_event` rows plus a LARGER `claude_code_tool_result` table,
 * because in practice it is bigger — and times one steady-state pass (every
 * session already delivered, which is what the lane spends almost all of its life
 * doing) and one pass with work owed.
 *
 * NOT A TEST. It is a measurement harness, run by hand, because a wall-clock
 * number is not a pass/fail assertion — `no-timing-assertions` is the rule this
 * deliberately stays on the right side of. The numbers it prints are recorded on
 * the ticket and in the PR body with the fixture size stated beside them.
 *
 * Run with the CURRENT tree for the "after" number, and against the pre-ISS-11323
 * operand (`--baseline`) for the "before" one: that flag runs the SAME outer query
 * over a union with the floor removed, which is exactly what shipped in #7722
 * widened to fourteen operands, so the two numbers differ only in the floor.
 *
 *   pnpm -C apps/desktop exec tsx scripts/measure-claude-code-candidate-scan.mts
 *   pnpm -C apps/desktop exec tsx scripts/measure-claude-code-candidate-scan.mts --baseline
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import { CANONICAL_UTC_TIMESTAMP_GLOB_SQL } from "../src/main/database/session-timestamp-form.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  CLAUDE_CODE_SIGNAL_SOURCES,
  loadClaudeCodeTelemetryCandidates,
} from "../src/main/otel/claude-code-telemetry-candidates.js";

/** ISS-7352's own measurement on one machine. */
const COST_EVENT_ROWS = 32_930;
/** `claude_code_tool_result` is usually larger than the cost table. */
const TOOL_RESULT_ROWS = 45_000;
const SESSIONS = 200;
const SOURCE_KEY = "claude_code_telemetry:measure";
const EPOCH_MS = Date.parse("2026-01-01T00:00:00.000Z");

/**
 * The union as it stood BEFORE ISS-11323 — GLOB only, no per-session floor —
 * over the same fourteen operands, so a baseline run differs from the current
 * one in the floor alone and not in the operand count.
 *
 * The baseline query below also keeps the LEFT JOIN and outer `HAVING` exactly as
 * #7722 shipped them, so the two numbers compare the WHOLE query and not a
 * simplified stand-in for it. That matters for the candidate counts as much as
 * the timing: without the `HAVING` the baseline would report 25 candidates on a
 * fully drained corpus, and the honest baseline reports 0 like the new query
 * does.
 */
const BASELINE_UNION = CLAUDE_CODE_SIGNAL_SOURCES.map(
  ([table, column]) =>
    `SELECT session_id, ${column} AS observed FROM ${table}
        WHERE ${column} GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}`
).join("\n  UNION ALL ");

function isoAt(index: number): string {
  return new Date(EPOCH_MS + index * 1000).toISOString();
}

async function main(): Promise<void> {
  const baseline = process.argv.includes("--baseline");
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss11323-measure-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => new Date().toISOString(),
  });
  try {
    const sessionIds: string[] = [];
    for (let i = 0; i < SESSIONS; i += 1) {
      const id = `measure-session-${i}`;
      sessionIds.push(id);
      await db.run(
        `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
         VALUES ($1, 'completed', $2, $2, 'claude', 'metered_api')`,
        id,
        isoAt(0)
      );
    }

    await bulkInsert(
      db,
      COST_EVENT_ROWS,
      (i) => [`cost-${i}`, sessionIds[i % SESSIONS], isoAt(i)],
      `INSERT INTO claude_code_cost_event
          (id, session_id, model, cost_usd, observed_at, attribution_key,
           attribution_source, data_revision)
        VALUES ($1, $2, 'claude-sonnet-4-5', 0.001, $3, '', 'otel', 1)`
    );

    await bulkInsert(
      db,
      TOOL_RESULT_ROWS,
      (i) => [`tool-${i}`, sessionIds[i % SESSIONS], isoAt(i)],
      `INSERT INTO claude_code_tool_result
          (id, session_id, tool_name, observed_at, result_key, data_revision)
        VALUES ($1, $2, 'Bash', $3, '', 1)`
    );

    // STEADY STATE: every session delivered, nothing owed. This is the pass the
    // lane spends almost all of its life doing.
    for (const id of sessionIds) {
      await db.run(
        `INSERT INTO claude_code_telemetry_sync_cursor
           (source_key, session_id, synced_observed_to, rejected_attempts,
            deferred_attempts, data_revision, updated_at)
         VALUES ($1, $2, $3, 0, 0, $4, $3)`,
        SOURCE_KEY,
        id,
        isoAt(TOOL_RESULT_ROWS + 1),
        effectiveDataRevision()
      );
    }
    const drained = await timePass(db, baseline);

    // WORK OWED: one session's cursor rolled back so its whole corpus is past
    // the watermark again.
    await db.run(
      `UPDATE claude_code_telemetry_sync_cursor
          SET synced_observed_to = $1 WHERE source_key = $2 AND session_id = $3`,
      isoAt(0),
      SOURCE_KEY,
      sessionIds[0]
    );
    const owed = await timePass(db, baseline);

    process.stdout.write(
      `${JSON.stringify(
        {
          variant: baseline
            ? "before (no per-session floor)"
            : "after (ISS-11323 floor)",
          fixture: {
            costEventRows: COST_EVENT_ROWS,
            toolResultRows: TOOL_RESULT_ROWS,
            sessions: SESSIONS,
            unionOperands: CLAUDE_CODE_SIGNAL_SOURCES.length,
            note: "the other twelve families are EMPTY in this fixture; the measurement therefore covers the two largest tables only and understates the operand count's own contribution",
          },
          steadyStatePassMs: drained.ms,
          steadyStateCandidates: drained.rows,
          workOwedPassMs: owed.ms,
          workOwedCandidates: owed.rows,
          passes: PASSES,
        },
        null,
        2
      )}\n`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Passes timed, reported as the MEDIAN — one sample on a loaded box is noise. */
const PASSES = 5;

async function timePass(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  baseline: boolean
): Promise<{ ms: number; rows: number }> {
  const samples: number[] = [];
  let rows = 0;
  for (let i = 0; i < PASSES; i += 1) {
    const started = performance.now();
    rows = await db.prisma.read(async (client) => {
      if (baseline) {
        const result = await client.$queryRawUnsafe<{ session_id: string }[]>(
          `SELECT o.session_id AS session_id,
                  MAX(o.observed) AS latest_observed_at,
                  MIN(o.observed) AS earliest_observed_at
             FROM (${BASELINE_UNION}) AS o
             LEFT JOIN claude_code_telemetry_sync_cursor c
               ON c.source_key = ?1 AND c.session_id = o.session_id
            GROUP BY o.session_id
           HAVING c.synced_observed_to IS NULL
               OR c.data_revision IS NULL
               OR c.data_revision <> ?3
               OR MAX(o.observed) > c.synced_observed_to
               OR (c.last_error = ?4 AND c.updated_at < ?5)
            ORDER BY latest_observed_at ASC
            LIMIT ?2`,
          SOURCE_KEY,
          25,
          effectiveDataRevision(),
          "session_absent",
          new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
        );
        return result.length;
      }
      const result = await loadClaudeCodeTelemetryCandidates(
        client,
        SOURCE_KEY,
        25
      );
      return result.length;
    });
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return { ms: Math.round(samples[Math.floor(PASSES / 2)] ?? 0), rows };
}

async function bulkInsert(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  count: number,
  argsFor: (index: number) => (string | undefined)[],
  sql: string
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await db.run(sql, ...argsFor(i));
  }
}

await main();

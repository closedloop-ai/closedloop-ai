/**
 * ISS-10717 — the rollup's "unknown is not zero" rule, at the grain it is
 * decided: which counts may be SENT at all.
 *
 * Two sessions, not one. A single-session fixture cannot tell a per-session
 * count from a machine-wide one, and the distinction under test is exactly that:
 * whether a family was recorded ON THIS MACHINE decides whether the count is
 * emitted, and the count itself is per session.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeCodeTelemetrySyncLocalError } from "../src/main/agent-sync/claude-code-telemetry-sync-service.js";
import { createClaudeCodeTelemetrySyncStore } from "../src/main/database/claude-code-telemetry-sync-store.js";
import { CLAUDE_CODE_TELEMETRY_SESSION_ABSENT_ERROR } from "../src/main/otel/claude-code-telemetry-candidates.js";
import {
  openTestDatabase,
  SESSION_ID,
  seedSession,
} from "./helpers/claude-code-otel-fixtures.js";

const OTHER_SESSION_ID = "claude-otel-second-session";
const SOURCE_KEY = "claude_code_telemetry:target-1";
const COST_AT = "2026-06-18T19:00:00.000Z";
const ERROR_AT = "2026-06-18T19:05:00.000Z";

type Db = Awaited<ReturnType<typeof openTestDatabase>>["db"];

async function seedSecondSession(db: Db): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
     VALUES ($1, 'completed', $2, $2, 'claude', 'metered_api')`,
    OTHER_SESSION_ID,
    "2026-06-18T18:00:00.000Z"
  );
}

async function seedCostEvent(db: Db, sessionId: string): Promise<void> {
  await db.run(
    `INSERT INTO claude_code_cost_event
       (id, session_id, model, cost_usd, observed_at, attribution_key,
        attribution_source, skill_name, data_revision)
     VALUES ($1, $2, 'claude-sonnet-4-5', 1.25, $3, 'skill:frankenstein',
             'otel', 'frankenstein', 1)`,
    `cost-${sessionId}`,
    sessionId,
    COST_AT
  );
}

async function seedErrorEvent(db: Db, sessionId: string): Promise<void> {
  await db.run(
    `INSERT INTO claude_code_error_event
       (id, session_id, error_kind, observed_at, occurrence_key, data_revision)
     VALUES ($1, $2, 'api_error', $3, '', 1)`,
    `err-${sessionId}`,
    sessionId,
    ERROR_AT
  );
}

test("ISS-10717: an unrecorded signal family is omitted, a measured zero is sent", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    await seedSecondSession(db);
    // The first session has cost events; the second has only an error event. So
    // `cost_event` IS recorded on this machine and `llm_request` is not — the
    // beta table nothing feeds.
    await seedCostEvent(db, SESSION_ID);
    await seedErrorEvent(db, OTHER_SESSION_ID);

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const pending = await store.loadPendingSessions(SOURCE_KEY, 10);
    const bySession = new Map(
      pending.map((entry) => [entry.sessionId, entry.session])
    );

    assert.equal(pending.length, 2);
    // Recorded on the machine, and this session genuinely has one: a MEASURED
    // count that must cross the wire.
    assert.equal(bySession.get(SESSION_ID)?.costEventCount, 1);
    // Recorded on the machine, and this session has none: a measured ZERO, not
    // an omission. Omitting it here would say "never captured" about a family
    // this machine captures.
    assert.equal(bySession.get(OTHER_SESSION_ID)?.costEventCount, 0);
    // NEVER recorded on this machine. `0` here would assert a measured absence
    // of LLM requests, which is false — the table is beta-gated and unfed.
    for (const session of bySession.values()) {
      assert.equal(session.llmRequestCount, undefined);
    }
  } finally {
    await cleanup();
  }
});

test("ISS-10717: component attribution survives the rollup", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    await seedCostEvent(db, SESSION_ID);

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const [pending] = await store.loadPendingSessions(SOURCE_KEY, 10);

    // The headline of the ticket: the harness stamps the component and we used
    // to throw it away. A rollup with no component grain would lose it again.
    assert.deepEqual(pending?.session.components, [
      {
        attributionKey: "skill:frankenstein",
        attributionSource: "otel",
        agentName: undefined,
        skillName: "frankenstein",
        pluginName: undefined,
        mcpServerName: undefined,
        mcpToolName: undefined,
        querySource: undefined,
        speed: undefined,
        effort: undefined,
        costEventCount: 1,
        costUsd: "1.25",
      },
    ]);
  } finally {
    await cleanup();
  }
});

test("ISS-10717: a delivered session leaves the owed set until its corpus moves", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    await seedCostEvent(db, SESSION_ID);
    const store = createClaudeCodeTelemetrySyncStore(db.prisma);

    const [first] = await store.loadPendingSessions(SOURCE_KEY, 10);
    assert.ok(first);
    await store.recordDelivered(SOURCE_KEY, SESSION_ID, first.observedTo);

    assert.deepEqual(await store.loadPendingSessions(SOURCE_KEY, 10), []);

    // A newer row past the acknowledged watermark makes it owed again. Without
    // this, telemetry that lands after the first delivery — the normal order,
    // since OTel arrives when Claude exits — would never reach the cloud.
    await seedErrorEvent(db, SESSION_ID);
    const owed = await store.loadPendingSessions(SOURCE_KEY, 10);
    assert.equal(owed.length, 1);
    assert.equal(owed[0]?.observedTo, ERROR_AT);
  } finally {
    await cleanup();
  }
});

test("ISS-10717: a session with no Claude Code rows is never shipped", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const store = createClaudeCodeTelemetrySyncStore(db.prisma);

    // A Codex, Cursor, Copilot or OpenCode session produces none of these
    // signals. Shipping an all-omitted row for it would create a cloud record
    // asserting nothing, which is worse than no record at all.
    assert.deepEqual(await store.loadPendingSessions(SOURCE_KEY, 10), []);
  } finally {
    await cleanup();
  }
});

test("ISS-10717: the candidate query's recovery arm reads the value the lane writes", () => {
  // Two spellings of one contract: the lane writes `last_error` and the
  // candidate query re-admits on it. Drift between them would close the
  // recovery door with nothing red.
  assert.equal(
    CLAUDE_CODE_TELEMETRY_SESSION_ABSENT_ERROR,
    ClaudeCodeTelemetrySyncLocalError.SessionAbsent
  );
});

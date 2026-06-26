/**
 * @file codex-otel-writer-prisma.test.ts
 * @description FEA-1791 / PLN-886 Phase 3 — electron-free coverage for the
 * Codex OTel writer after its move onto the single `DesktopPrisma` client.
 * Builds the writer over the shared {@link openTestPrisma} harness and calls
 * `persistCodexOtelBatch` directly (mirroring the sqlite.ts wrapper: parse, then
 * persist) so the conversion mechanics — the typed `codexTraceSpan.upsert`, the
 * raw session/token_usage upserts, and the single atomic `$transaction` — run
 * locally instead of only behind the electron-tainted integration harness in
 * codex-otel-writer.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DATA_REVISION } from "../src/main/collectors/data-revision.js";
import {
  CodexOtelSpanStatus,
  CodexOtelTokenUsageSource,
  parseCodexOtelBatch,
} from "../src/main/otel/codex-otel-contract.js";
import { persistCodexOtelBatch } from "../src/main/otel/codex-otel-writer.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

const NOW = "2026-06-18T12:00:00.000Z";

type Store = OpenTestPrisma["db"];
type Prisma = OpenTestPrisma["prisma"];

/** Mirror sqlite.ts's `codexOtel.persistBatch`: validate, then persist. */
async function persistBatch(prisma: Prisma, rawBatch: unknown): Promise<void> {
  await persistCodexOtelBatch({
    prisma,
    batch: parseCodexOtelBatch(rawBatch),
    now: NOW,
  });
}

test("Codex OTel batch persists span (typed), session + token usage (raw), idempotently", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const batch = makeBatch();
    await persistBatch(prisma, batch);
    await persistBatch(prisma, batch);

    const spans = await selectSpans(store, "otel-session");
    assert.equal(spans.length, 1);
    assert.equal(spans[0].trace_id, "trace-1");
    assert.equal(spans[0].span_id, "span-1");
    assert.equal(spans[0].duration_ms, 125);
    assert.equal(spans[0].tool_name, "shell");
    assert.equal(spans[0].revision_id, DATA_REVISION);
    const attributes = JSON.parse(spans[0].attributes) as Record<
      string,
      unknown
    >;
    assert.equal(attributes["gen_ai.system"], "codex");

    const session = await getSession(store, "otel-session");
    assert.equal(session?.harness, "codex");
    assert.equal(session?.status, "active");

    const usage = await selectTokenUsage(store, "otel-session");
    assert.equal(usage.length, 1);
    assert.equal(usage[0].input_tokens, 11);
    assert.equal(usage[0].output_tokens, 7);
    assert.equal(usage[0].cache_read_tokens, 3);
    assert.equal(usage[0].cache_write_tokens, 2);
    assert.equal(
      usage[0].usage_source,
      CodexOtelTokenUsageSource.OtelLogPayload
    );
    assert.equal(usage[0].revision_id, DATA_REVISION);
  } finally {
    await close();
  }
});

test("Codex OTel batch is atomic: a failing op rolls back the session and span writes", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // Drop token_usage so the final op in the transaction throws; the whole
    // $transaction([...]) must roll back the session + span writes queued ahead
    // of it.
    await store.query("DROP TABLE token_usage");

    await assert.rejects(() => persistBatch(prisma, makeBatch()));

    assert.equal(await getSession(store, "otel-session"), undefined);
    assert.equal(await countSpans(store, "otel-session"), 0);
  } finally {
    await close();
  }
});

test("Codex OTel session upsert preserves an existing harness/start/billing on re-ingest", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // A session already imported from a Claude transcript: the codex OTel batch
    // must not clobber the authoritative harness/start/billing/updated_at via
    // its conditional ON CONFLICT merge.
    await store.query(
      `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode, metadata, data_revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        "otel-session",
        "running",
        "2026-01-01T00:00:00.000Z",
        "2099-01-01T00:00:00.000Z",
        "claude",
        "metered_api",
        "{}",
        DATA_REVISION,
      ]
    );

    await persistBatch(prisma, makeBatch());

    const session = await getSession(store, "otel-session");
    assert.equal(session?.harness, "claude");
    assert.equal(session?.billing_mode, "metered_api");
    assert.equal(session?.started_at, "2026-01-01T00:00:00.000Z");
    // updated_at only advances forward; the seeded future timestamp wins.
    assert.equal(session?.updated_at, "2099-01-01T00:00:00.000Z");
    // The span still persists under the pre-existing session row (FK satisfied).
    assert.equal(await countSpans(store, "otel-session"), 1);
  } finally {
    await close();
  }
});

test("Codex OTel token usage upsert heals created_at downward via the MIN merge", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await persistBatch(prisma, makeTokenUsageBatch("2026-06-18T12:00:02.000Z"));
    await persistBatch(prisma, makeTokenUsageBatch("2026-06-18T12:00:01.000Z"));

    const rows = await store.query<{ created_at: string }>(
      "SELECT created_at FROM token_usage WHERE session_id = $1 AND model = $2",
      ["otel-session", "gpt-5-codex"]
    );
    assert.equal(rows.rows.length, 1);
    // MIN(token_usage.created_at, EXCLUDED.created_at): the earlier instant wins.
    assert.equal(rows.rows[0].created_at, "2026-06-18T12:00:01.000Z");
  } finally {
    await close();
  }
});

function makeBatch() {
  return {
    spans: [makeSpan()],
    tokenUsage: [
      {
        sessionId: "otel-session",
        model: "gpt-5-codex",
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        observedAt: "2026-06-18T12:00:00.500Z",
      },
    ],
  };
}

function makeTokenUsageBatch(observedAt: string) {
  return {
    tokenUsage: [
      {
        sessionId: "otel-session",
        model: "gpt-5-codex",
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        observedAt,
      },
    ],
  };
}

function makeSpan() {
  return {
    traceId: "trace-1",
    spanId: "span-1",
    sessionId: "otel-session",
    name: "codex.exec",
    startTime: "2026-06-18T12:00:00.000Z",
    endTime: "2026-06-18T12:00:00.125Z",
    durationMs: 125,
    status: CodexOtelSpanStatus.Ok,
    toolName: "shell",
    attributes: {
      "gen_ai.system": "codex",
      "codex.tool.name": "shell",
      "session.id": "otel-session",
    },
  };
}

async function selectSpans(store: Store, sessionId: string) {
  const result = await store.query<{
    trace_id: string;
    span_id: string;
    duration_ms: number;
    tool_name: string | null;
    revision_id: number;
    attributes: string;
  }>("SELECT * FROM codex_trace_span WHERE session_id = $1", [sessionId]);
  return result.rows;
}

async function countSpans(store: Store, sessionId: string): Promise<number> {
  const result = await store.query<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM codex_trace_span WHERE session_id = $1",
    [sessionId]
  );
  return Number(result.rows[0].cnt);
}

async function getSession(store: Store, id: string) {
  const result = await store.query<{
    harness: string | null;
    status: string | null;
    started_at: string | null;
    updated_at: string | null;
    billing_mode: string | null;
  }>(
    "SELECT harness, status, started_at, updated_at, billing_mode FROM sessions WHERE id = $1",
    [id]
  );
  return result.rows[0];
}

async function selectTokenUsage(store: Store, sessionId: string) {
  const result = await store.query<{
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    usage_source: string;
    revision_id: number;
  }>(
    `SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usage_source, revision_id
     FROM token_usage WHERE session_id = $1 ORDER BY model ASC`,
    [sessionId]
  );
  return result.rows.map((row) => ({
    ...row,
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    cache_read_tokens: Number(row.cache_read_tokens),
    cache_write_tokens: Number(row.cache_write_tokens),
  }));
}

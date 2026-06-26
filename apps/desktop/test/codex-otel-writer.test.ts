import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DATA_REVISION } from "../src/main/collectors/data-revision.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  CODEX_OTEL_MAX_ATTRIBUTE_COUNT,
  CODEX_OTEL_MAX_ATTRIBUTE_STRING_LENGTH,
  CODEX_OTEL_MAX_BATCH_SPANS,
  CODEX_OTEL_MAX_BATCH_TOKEN_USAGE,
  CODEX_OTEL_MAX_MODEL_LENGTH,
  CODEX_OTEL_MAX_REDACTED_ATTRIBUTE_COUNT,
  CODEX_OTEL_MAX_SPAN_NAME_LENGTH,
  CODEX_OTEL_MAX_STATUS_MESSAGE_LENGTH,
  CodexOtelSpanStatus,
  CodexOtelTokenUsageSource,
} from "../src/main/otel/codex-otel-contract.js";
import {
  ALLOWED_ATTRIBUTE_KEYS,
  CODEX_TRACE_SPAN_TABLE,
  REDACTED_ATTRIBUTES_KEY,
  REDACTED_SPAN_NAME,
} from "../src/main/otel/codex-otel-writer.js";

const LARGE_CACHE_READ_TOKENS = 2_192_635_647;

test("Codex OTel batch persists spans, minimal session, token source, and replay is idempotent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-writer-"));
  const db = await openTestDb(dir);
  try {
    const batch = makeBatch();
    await db.codexOtel.persistBatch(batch);
    await db.codexOtel.persistBatch(batch);

    const spans = await db.prisma.client.$queryRawUnsafe<
      {
        trace_id: string;
        span_id: string;
        session_id: string;
        duration_ms: number;
        tool_name: string | null;
        revision_id: number;
      }[]
    >("SELECT * FROM codex_trace_span WHERE session_id = $1", "otel-session");
    assert.equal(spans.length, 1);
    assert.equal(spans[0].trace_id, "trace-1");
    assert.equal(spans[0].span_id, "span-1");
    assert.equal(spans[0].duration_ms, 125);
    assert.equal(spans[0].tool_name, "shell");
    assert.equal(spans[0].revision_id, DATA_REVISION);

    const session = await db.sessions.getById("otel-session");
    assert.equal(session?.harness, "codex");
    assert.equal(session?.status, "active");

    const tokenRows = await selectTokenUsage(db, "otel-session");
    assert.equal(tokenRows.length, 1);
    assert.equal(tokenRows[0].input_tokens, 11);
    assert.equal(tokenRows[0].output_tokens, 7);
    assert.equal(tokenRows[0].cache_read_tokens, 3);
    assert.equal(tokenRows[0].cache_write_tokens, 2);
    assert.equal(
      tokenRows[0].usage_source,
      CodexOtelTokenUsageSource.OtelLogPayload
    );
    assert.equal(tokenRows[0].revision_id, DATA_REVISION);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex OTel token usage persists large token counters exactly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-large-"));
  const db = await openTestDb(dir);
  try {
    const batch = makeBatch();
    batch.tokenUsage[0].cacheReadTokens = LARGE_CACHE_READ_TOKENS;

    await db.codexOtel.persistBatch(batch);

    const tokenRows = await selectTokenUsage(db, "otel-session");
    assert.equal(tokenRows.length, 1);
    assert.equal(tokenRows[0].cache_read_tokens, LARGE_CACHE_READ_TOKENS);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex OTel rejects unsafe token counters before writes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-unsafe-"));
  const db = await openTestDb(dir);
  try {
    const batch = makeBatch();
    batch.tokenUsage[0].cacheReadTokens = Number.MAX_SAFE_INTEGER + 1;

    await assert.rejects(() => db.codexOtel.persistBatch(batch));

    assert.equal(await db.sessions.getById("otel-session"), undefined);
    assert.equal(await countRows(db, "codex_trace_span", "otel-session"), 0);
    assert.deepEqual(await selectTokenUsage(db, "otel-session"), []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex OTel empty batch is silent and leaves parser token usage unchanged", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-silence-"));
  const db = await openTestDb(dir);
  try {
    await db.tokenUsage.replace(
      "silent-session",
      "codex-model",
      { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      "2026-06-18T12:00:00.000Z"
    );

    await db.codexOtel.persistBatch({ spans: [], tokenUsage: [] });

    assert.deepEqual(await selectTokenUsage(db, "silent-session"), [
      {
        session_id: "silent-session",
        model: "codex-model",
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 3,
        cache_write_tokens: 4,
        usage_source: CodexOtelTokenUsageSource.JsonlParser,
        revision_id: DATA_REVISION,
      },
    ]);
    const spanCount = await countRows(db, "codex_trace_span", "silent-session");
    assert.equal(spanCount, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex OTel sanitizer persists allowlisted attributes and omits sensitive values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-attrs-"));
  const db = await openTestDb(dir);
  try {
    await db.codexOtel.persistBatch({
      spans: [
        {
          ...makeSpan(),
          attributes: {
            "gen_ai.system": "codex",
            "gen_ai.request.model": "gpt-5-codex",
            "code.function.name": "exec",
            "tool.input": "run secret command",
            "http.request.header.authorization": "Bearer abc",
            "tool.output": "",
            "custom.unknown": "not persisted",
          },
        },
      ],
    });

    const result = await db.prisma.client.$queryRawUnsafe<
      { attributes: unknown }[]
    >(
      "SELECT attributes FROM codex_trace_span WHERE session_id = $1",
      "otel-session"
    );
    const attributes = parseJsonRecord(result[0].attributes);

    assert.equal(attributes["gen_ai.system"], "codex");
    assert.equal(attributes["gen_ai.request.model"], "gpt-5-codex");
    assert.equal(attributes["code.function.name"], "exec");
    assert.equal(attributes["tool.input"], undefined);
    assert.equal(attributes["tool.output"], undefined);
    assert.equal(attributes["custom.unknown"], undefined);
    assert.deepEqual(attributes[REDACTED_ATTRIBUTES_KEY], [
      "http.request.header.authorization",
      "tool.input",
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex OTel sanitizer bounds stored values and redaction markers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-attr-bounds-"));
  const db = await openTestDb(dir);
  try {
    const sensitiveAttributes = Object.fromEntries(
      Array.from(
        { length: CODEX_OTEL_MAX_REDACTED_ATTRIBUTE_COUNT + 4 },
        (_, index) => [`tool.input.${index}`, `secret-${index}`]
      )
    );
    await db.codexOtel.persistBatch({
      spans: [
        {
          ...makeSpan(),
          attributes: {
            "gen_ai.request.model": "x".repeat(
              CODEX_OTEL_MAX_ATTRIBUTE_STRING_LENGTH + 8
            ),
            ...sensitiveAttributes,
          },
        },
      ],
    });

    const result = await db.prisma.client.$queryRawUnsafe<
      { attributes: unknown }[]
    >(
      "SELECT attributes FROM codex_trace_span WHERE session_id = $1",
      "otel-session"
    );
    const attributes = parseJsonRecord(result[0].attributes);

    assert.equal(
      (attributes["gen_ai.request.model"] as string).length,
      CODEX_OTEL_MAX_ATTRIBUTE_STRING_LENGTH
    );
    assert.equal(
      (attributes[REDACTED_ATTRIBUTES_KEY] as string[]).length,
      CODEX_OTEL_MAX_REDACTED_ATTRIBUTE_COUNT
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex OTel rejects oversized attribute records before writing rows", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "codex-otel-attr-count-limit-")
  );
  const db = await openTestDb(dir);
  try {
    await assert.rejects(() =>
      db.codexOtel.persistBatch({
        spans: [
          {
            ...makeSpan(),
            attributes: Object.fromEntries(
              Array.from(
                { length: CODEX_OTEL_MAX_ATTRIBUTE_COUNT + 1 },
                (_, index) => [`custom.${index}`, index]
              )
            ),
          },
        ],
      })
    );

    assert.equal(await db.sessions.getById("otel-session"), undefined);
    assert.equal(await countRows(db, "codex_trace_span", "otel-session"), 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex OTel rejects oversized free-form fields before writing rows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-field-bounds-"));
  const db = await openTestDb(dir);
  try {
    await assert.rejects(() =>
      db.codexOtel.persistBatch({
        spans: [
          {
            ...makeSpan(),
            name: "x".repeat(CODEX_OTEL_MAX_SPAN_NAME_LENGTH + 1),
          },
        ],
        tokenUsage: [
          {
            sessionId: "otel-session",
            model: "x".repeat(CODEX_OTEL_MAX_MODEL_LENGTH + 1),
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            observedAt: "2026-06-18T12:00:00.000Z",
          },
        ],
      })
    );

    await assert.rejects(() =>
      db.codexOtel.persistBatch({
        spans: [
          {
            ...makeSpan(),
            statusMessage: "x".repeat(CODEX_OTEL_MAX_STATUS_MESSAGE_LENGTH + 1),
          },
        ],
      })
    );

    await assert.rejects(() =>
      db.codexOtel.persistBatch({
        spans: [
          {
            ...makeSpan(),
            toolName: "x".repeat(CODEX_OTEL_MAX_SPAN_NAME_LENGTH + 1),
          },
        ],
      })
    );

    assert.equal(await db.sessions.getById("otel-session"), undefined);
    assert.equal(await countRows(db, "codex_trace_span", "otel-session"), 0);
    assert.deepEqual(await selectTokenUsage(db, "otel-session"), []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex OTel rejects oversized batches before writing rows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-batch-limit-"));
  const db = await openTestDb(dir);
  try {
    await assert.rejects(() =>
      db.codexOtel.persistBatch({
        spans: Array.from({ length: CODEX_OTEL_MAX_BATCH_SPANS + 1 }, () =>
          makeSpan()
        ),
        tokenUsage: Array.from(
          { length: CODEX_OTEL_MAX_BATCH_TOKEN_USAGE + 1 },
          () => ({
            sessionId: "otel-session",
            model: "gpt-5-codex",
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            observedAt: "2026-06-18T12:00:00.000Z",
          })
        ),
      })
    );

    assert.equal(await db.sessions.getById("otel-session"), undefined);
    assert.equal(await countRows(db, "codex_trace_span", "otel-session"), 0);
    assert.deepEqual(await selectTokenUsage(db, "otel-session"), []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex OTel sanitizes sensitive free-form span fields before storage", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "codex-otel-sensitive-fields-")
  );
  const db = await openTestDb(dir);
  try {
    await db.codexOtel.persistBatch({
      spans: [
        {
          ...makeSpan(),
          name: "prompt: summarize hidden text",
          statusMessage: "tool output: secret response",
          toolName: "authorization: bearer token",
        },
      ],
    });

    const result = await db.prisma.client.$queryRawUnsafe<
      {
        name: string;
        status_message: string | null;
        tool_name: string | null;
      }[]
    >(
      "SELECT name, status_message, tool_name FROM codex_trace_span WHERE session_id = $1",
      "otel-session"
    );

    assert.equal(result[0].name, REDACTED_SPAN_NAME);
    assert.equal(result[0].status_message, null);
    assert.equal(result[0].tool_name, null);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex OTel minimal session start uses earliest parseable instant across offsets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-offsets-"));
  const db = await openTestDb(dir);
  try {
    await db.codexOtel.persistBatch({
      spans: [
        {
          ...makeSpan(),
          traceId: "trace-later",
          spanId: "span-later",
          startTime: "2026-06-18T08:30:00-05:00",
          endTime: "2026-06-18T08:31:00-05:00",
        },
        {
          ...makeSpan(),
          traceId: "trace-earlier",
          spanId: "span-earlier",
          startTime: "2026-06-18T10:00:00+02:00",
          endTime: "2026-06-18T10:01:00+02:00",
        },
      ],
      tokenUsage: [
        {
          sessionId: "otel-session",
          model: "gpt-5-codex",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          observedAt: "2026-06-18T09:00:00Z",
        },
      ],
    });

    const session = await db.prisma.client.$queryRawUnsafe<
      { started_at: string }[]
    >("SELECT started_at FROM sessions WHERE id = $1", "otel-session");

    assert.equal(session[0].started_at, "2026-06-18T10:00:00+02:00");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex OTel parser fallback cannot overwrite authoritative OTel token usage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-precedence-"));
  const db = await openTestDb(dir);
  try {
    await db.tokenUsage.replace(
      "precedence-session",
      "parser-only",
      { input: 5, output: 4, cacheRead: 3, cacheWrite: 2 },
      "2026-06-18T12:00:00.000Z"
    );
    await db.codexOtel.persistBatch({
      tokenUsage: [
        {
          sessionId: "precedence-session",
          model: "gpt-5-codex",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 25,
          cacheWriteTokens: 10,
          observedAt: "2026-06-18T12:01:00.000Z",
        },
      ],
    });
    await db.tokenUsage.replace(
      "precedence-session",
      "gpt-5-codex",
      { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      "2026-06-18T12:02:00.000Z"
    );
    await db.tokenUsage.replace(
      "precedence-session",
      "parser-only",
      { input: 6, output: 5, cacheRead: 4, cacheWrite: 3 },
      "2026-06-18T12:02:00.000Z"
    );

    const rows = await selectTokenUsage(db, "precedence-session");
    assert.deepEqual(rows, [
      {
        session_id: "precedence-session",
        model: "gpt-5-codex",
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 25,
        cache_write_tokens: 10,
        usage_source: CodexOtelTokenUsageSource.OtelLogPayload,
        revision_id: DATA_REVISION,
      },
      {
        session_id: "precedence-session",
        model: "parser-only",
        input_tokens: 6,
        output_tokens: 5,
        cache_read_tokens: 4,
        cache_write_tokens: 3,
        usage_source: CodexOtelTokenUsageSource.JsonlParser,
        revision_id: DATA_REVISION,
      },
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex OTel invalid input rejects before writing session, span, or token rows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-invalid-"));
  const db = await openTestDb(dir);
  try {
    await assert.rejects(() =>
      db.codexOtel.persistBatch({
        spans: [
          {
            ...makeSpan(),
            status: "unknown",
          },
        ],
        tokenUsage: [
          {
            sessionId: "otel-session",
            model: "gpt-5-codex",
            inputTokens: -1,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            observedAt: "2026-06-18T12:00:00.000Z",
          },
        ],
      })
    );

    assert.equal(await db.sessions.getById("otel-session"), undefined);
    assert.equal(await countRows(db, "codex_trace_span", "otel-session"), 0);
    assert.deepEqual(await selectTokenUsage(db, "otel-session"), []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex OTel transaction failure rolls back session and span writes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-rollback-"));
  const db = await openTestDb(dir);
  try {
    await db.run("DROP TABLE token_usage");

    await assert.rejects(() => db.codexOtel.persistBatch(makeBatch()));

    assert.equal(await db.sessions.getById("otel-session"), undefined);
    assert.equal(await countRows(db, "codex_trace_span", "otel-session"), 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex OTel migration literals and attribute allowlist stay pinned", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-literals-"));
  const db = await openTestDb(dir);
  try {
    const table = await db.prisma.client.$queryRawUnsafe<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1",
      CODEX_TRACE_SPAN_TABLE
    );
    assert.equal(table[0].name, CODEX_TRACE_SPAN_TABLE);

    // SQLite reports the explicit secondary indexes by name; the primary-key
    // index is an implicit `sqlite_autoindex_*` rather than a named `_pkey`,
    // so assert on the named secondary indexes the migration creates.
    const indexes = await db.prisma.client.$queryRawUnsafe<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = $1 AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
      CODEX_TRACE_SPAN_TABLE
    );
    assert.deepEqual(
      indexes.map((row) => row.name),
      [
        "idx_codex_trace_span_session",
        "idx_codex_trace_span_start_time",
        "idx_codex_trace_span_tool",
      ]
    );
    assert.equal(CodexOtelSpanStatus.Unset, "unset");
    assert.equal(CodexOtelSpanStatus.Ok, "ok");
    assert.equal(CodexOtelSpanStatus.Error, "error");
    assert.ok(ALLOWED_ATTRIBUTE_KEYS.has("gen_ai.system"));
    assert.ok(ALLOWED_ATTRIBUTE_KEYS.has("codex.tool.name"));
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function openTestDb(
  dir: string,
  extraOpts?: Partial<Parameters<typeof openSqliteAgentDatabase>[0]>
) {
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-18T12:00:00.000Z",
    ...extraOpts,
  });
}

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

async function selectTokenUsage(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  sessionId: string
) {
  const result = await db.prisma.client.$queryRawUnsafe<
    {
      session_id: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      usage_source: string;
      revision_id: number;
    }[]
  >(
    `SELECT
       session_id, model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, usage_source, revision_id
     FROM token_usage
     WHERE session_id = $1
     ORDER BY model ASC`,
    sessionId
  );
  return result.map((row) => ({
    ...row,
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    cache_read_tokens: Number(row.cache_read_tokens),
    cache_write_tokens: Number(row.cache_write_tokens),
  }));
}

async function countRows(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  tableName: string,
  sessionId: string
): Promise<number> {
  const result = await db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
    `SELECT COUNT(*) AS cnt FROM ${tableName} WHERE session_id = $1`,
    sessionId
  );
  return result[0].cnt;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }
  return value as Record<string, unknown>;
}

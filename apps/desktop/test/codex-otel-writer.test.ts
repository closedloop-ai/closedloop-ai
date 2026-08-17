import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DATA_REVISION } from "../src/main/collectors/engine/data-revision.js";
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

    // FEA-3743: the earliest instant (10:00+02:00 == 08:00 UTC) wins AND is
    // stored in canonical ISO-8601 UTC 'Z' form, not its offset input form. The
    // instant is preserved exactly; only the text representation is normalized
    // so the lexically-compared column stays single-format.
    assert.equal(session[0].started_at, "2026-06-18T08:00:00.000Z");
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

// FEA-3591: the minimal session upsert must seed `last_activity_at` so an
// OTel-only row satisfies the `last_activity_at >= started_at` invariant from
// birth. Before the fix the column fell to its 1970 epoch DEFAULT — a live
// violation (and a poisoned `ended_at = epoch` if the orphan sweep caught the
// row first). Equality with `started_at` is correct for an events-less session
// (recompute's COALESCE(MAX(events), started_at) floored ≡ started_at) and is
// form-safe: it holds for offset-form timestamps too, with no string MAX.
test("Codex OTel minimal session seeds last_activity_at = started_at (FEA-3591)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-floor-"));
  const db = await openTestDb(dir);
  try {
    await db.codexOtel.persistBatch({
      spans: [
        {
          ...makeSpan(),
          traceId: "trace-z",
          spanId: "span-z",
          sessionId: "otel-z-form",
          startTime: "2026-06-18T12:00:00.000Z",
          endTime: "2026-06-18T12:01:00.000Z",
        },
        {
          ...makeSpan(),
          traceId: "trace-offset",
          spanId: "span-offset",
          sessionId: "otel-offset-form",
          startTime: "2026-06-18T10:00:00+02:00",
          endTime: "2026-06-18T10:01:00+02:00",
        },
      ],
      tokenUsage: [],
    });

    const rows = await db.prisma.client.$queryRawUnsafe<
      { id: string; started_at: string; last_activity_at: string }[]
    >(
      "SELECT id, started_at, last_activity_at FROM sessions WHERE id IN ($1, $2) ORDER BY id",
      "otel-offset-form",
      "otel-z-form"
    );
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.last_activity_at, row.started_at, row.id);
    }

    // A second batch for the same session must NOT touch last_activity_at —
    // the ON CONFLICT arm leaves the column to recomputeSessionLastActivityAt
    // (a string MAX there could regress mixed-form values).
    await db.codexOtel.persistBatch({
      spans: [
        {
          ...makeSpan(),
          traceId: "trace-z-2",
          spanId: "span-z-2",
          sessionId: "otel-z-form",
          startTime: "2026-06-18T14:00:00.000Z",
          endTime: "2026-06-18T14:01:00.000Z",
        },
      ],
      tokenUsage: [],
    });
    const after = await db.prisma.client.$queryRawUnsafe<
      { last_activity_at: string }[]
    >("SELECT last_activity_at FROM sessions WHERE id = $1", "otel-z-form");
    assert.equal(after[0]?.last_activity_at, "2026-06-18T12:00:00.000Z");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-3743: the OTel writer is the known offender that used to persist
// timestamps in their raw incoming form, including timezone-offset forms. Every
// timestamp it writes — span start/end, the derived session started_at/
// last_activity_at, and token_usage.created_at — must now land in canonical
// ISO-8601 UTC 'Z' form (same instant, single text format) so the lexically-
// compared columns sort chronologically.
test("Codex OTel writer normalizes all offset-form timestamps to canonical UTC 'Z' at write time (FEA-3743)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-canonical-"));
  const db = await openTestDb(dir);
  try {
    await db.codexOtel.persistBatch({
      spans: [
        {
          ...makeSpan(),
          traceId: "trace-offset",
          spanId: "span-offset",
          // 10:00+02:00 == 08:00 UTC, 10:01+02:00 == 08:01 UTC.
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
          // 06:30-05:00 == 11:30 UTC.
          observedAt: "2026-06-18T06:30:00-05:00",
        },
      ],
    });

    const span = await db.prisma.client.$queryRawUnsafe<
      { start_time: string; end_time: string }[]
    >(
      "SELECT start_time, end_time FROM codex_trace_span WHERE trace_id = $1",
      "trace-offset"
    );
    assert.equal(span[0].start_time, "2026-06-18T08:00:00.000Z");
    assert.equal(span[0].end_time, "2026-06-18T08:01:00.000Z");

    const usage = await db.prisma.client.$queryRawUnsafe<
      { created_at: string }[]
    >(
      "SELECT created_at FROM token_usage WHERE session_id = $1 AND model = $2",
      "otel-session",
      "gpt-5-codex"
    );
    assert.equal(usage[0].created_at, "2026-06-18T11:30:00.000Z");

    // Earliest instant across the span (08:00Z) and usage (11:30Z) wins the
    // session start, and it too is stored canonical.
    const session = await db.prisma.client.$queryRawUnsafe<
      { started_at: string; last_activity_at: string }[]
    >(
      "SELECT started_at, last_activity_at FROM sessions WHERE id = $1",
      "otel-session"
    );
    assert.equal(session[0].started_at, "2026-06-18T08:00:00.000Z");
    assert.equal(session[0].last_activity_at, "2026-06-18T08:00:00.000Z");

    // No non-canonical residue anywhere in the healed columns: every date-shaped
    // value ends in 'Z'. (A `%-%` / `%+%` LIKE would false-match the date's own
    // hyphens; the canonical marker is the trailing 'Z'.)
    const nonZ = (column: string): string =>
      `${column} IS NOT NULL
         AND ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'
         AND ${column} NOT LIKE '%Z'`;
    const residue = await db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
      `SELECT
         (SELECT COUNT(*) FROM sessions
            WHERE ${nonZ("started_at")} OR ${nonZ("last_activity_at")})
       + (SELECT COUNT(*) FROM token_usage WHERE ${nonZ("created_at")})
       + (SELECT COUNT(*) FROM codex_trace_span
            WHERE ${nonZ("start_time")} OR ${nonZ("end_time")})
         AS cnt`
    );
    assert.equal(Number(residue[0].cnt), 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-3743: rows an EARLIER build persisted in offset form (before the write-
// path fix) are healed to canonical UTC 'Z' by the post-backfill maintenance
// pass. The data-revision rebuild can't reach these OTel-only rows (no source
// transcript), so a dedicated in-place heal owns the migration.
test("normalizeStoredTimestampFormats heals pre-existing offset-form rows to canonical UTC 'Z' (FEA-3743)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-heal-"));
  const db = await openTestDb(dir);
  try {
    // Simulate legacy offset-form rows written by a pre-fix build by writing the
    // raw offset text directly (bypassing the now-normalizing writer).
    // Seed `updated_at` in the PAST so the heal's watermark bump (to the fixed
    // test `now` = 2026-06-18T12:00:00.000Z) is observable — this is what makes
    // the FEA-1962 `updated_at >= watermark` sync scan re-select an already-synced
    // terminal session so the corrected instant reaches the cloud.
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO sessions (
           id, status, started_at, last_activity_at, updated_at,
           harness, billing_mode, data_revision
         ) VALUES ($1, 'active', $2, $3, $4, 'codex', 'unknown', $5)`,
        "legacy-offset",
        "2026-06-18T10:00:00+02:00",
        "2026-06-18T10:05:00+02:00",
        "2026-06-18T09:00:00.000Z",
        DATA_REVISION
      )
    );
    // A pre-existing derived analytics row carrying the OLD offset-form
    // `started_at` (as the pre-fix rollup would have persisted it). The heal must
    // re-derive this so the sync-emitted `sessionAnalytics.startedAt` copy is
    // canonical too — the analytics backfill only anti-joins MISSING rows.
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO session_analytics (session_id, started_at, updated_at)
         VALUES ($1, $2, $3)`,
        "legacy-offset",
        "2026-06-18T10:00:00+02:00",
        "2026-06-18T09:00:00.000Z"
      )
    );
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO token_usage (
           session_id, model, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, usage_source, revision_id,
           created_at, updated_at
         ) VALUES ($1, $2, 1, 1, 0, 0, $3, $4, $5, $6)`,
        "legacy-offset",
        "gpt-5-codex",
        CodexOtelTokenUsageSource.OtelLogPayload,
        DATA_REVISION,
        "2026-06-18T06:30:00-05:00",
        "2026-06-18T12:00:00.000Z"
      )
    );
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO codex_trace_span (
           trace_id, span_id, session_id, name, start_time, end_time,
           duration_ms, status, received_at, revision_id, attributes,
           resource_attributes
         ) VALUES ($1, $2, $3, 'codex.exec', $4, $5, 125, 'ok', $6, $7, '{}', '{}')`,
        "legacy-trace",
        "legacy-span",
        "legacy-offset",
        "2026-06-18T10:00:00+02:00",
        "2026-06-18T10:01:00+02:00",
        "2026-06-18T12:00:00.000Z",
        DATA_REVISION
      )
    );

    const rewritten = await db.normalizeStoredTimestampFormats();
    assert.equal(rewritten, 5);

    const session = await db.prisma.client.$queryRawUnsafe<
      { started_at: string; last_activity_at: string }[]
    >(
      "SELECT started_at, last_activity_at FROM sessions WHERE id = $1",
      "legacy-offset"
    );
    assert.equal(session[0].started_at, "2026-06-18T08:00:00.000Z");
    assert.equal(session[0].last_activity_at, "2026-06-18T08:05:00.000Z");

    // FEA-3743: healing the session timestamps must ALSO bump `updated_at` so the
    // durable sync watermark re-selects this already-synced terminal session and
    // the corrected instant reaches the cloud.
    const watermark = await db.prisma.client.$queryRawUnsafe<
      { updated_at: string }[]
    >("SELECT updated_at FROM sessions WHERE id = $1", "legacy-offset");
    assert.equal(watermark[0].updated_at, "2026-06-18T12:00:00.000Z");

    // FEA-3743: the derived, sync-emitted `session_analytics.started_at` copy is
    // re-derived from the healed source so it is canonical too.
    const analytics = await db.prisma.client.$queryRawUnsafe<
      { started_at: string }[]
    >(
      "SELECT started_at FROM session_analytics WHERE session_id = $1",
      "legacy-offset"
    );
    assert.equal(analytics[0].started_at, "2026-06-18T08:00:00.000Z");

    const usage = await db.prisma.client.$queryRawUnsafe<
      { created_at: string }[]
    >(
      "SELECT created_at FROM token_usage WHERE session_id = $1",
      "legacy-offset"
    );
    assert.equal(usage[0].created_at, "2026-06-18T11:30:00.000Z");

    const span = await db.prisma.client.$queryRawUnsafe<
      { start_time: string; end_time: string }[]
    >(
      "SELECT start_time, end_time FROM codex_trace_span WHERE trace_id = $1",
      "legacy-trace"
    );
    assert.equal(span[0].start_time, "2026-06-18T08:00:00.000Z");
    assert.equal(span[0].end_time, "2026-06-18T08:01:00.000Z");

    // Idempotent: a second pass over the now-canonical store rewrites nothing.
    assert.equal(await db.normalizeStoredTimestampFormats(), 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

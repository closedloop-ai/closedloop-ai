/**
 * @file ISS-11283 branch coverage for persistCodexOtelBatch paths the existing
 * suites never reach directly: an empty batch handed straight to the writer
 * (the sqlite.ts wrapper always filters that case out before calling in), the
 * resolveToolName attribute-fallback chain (every existing fixture span sets a
 * truthy `toolName`), and a whitespace-only free-form field collapsing under
 * trim. Uses the same electron-free `openTestPrisma` harness as
 * codex-otel-writer-prisma.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  CODEX_OTEL_MAX_STATUS_MESSAGE_LENGTH,
  CodexOtelSpanStatus,
  parseCodexOtelBatch,
} from "../src/main/otel/codex-otel-contract.js";
import { persistCodexOtelBatch } from "../src/main/otel/codex-otel-writer.js";
import {
  makeRecordingQueue,
  type OpenTestPrisma,
  openTestPrisma,
} from "./prisma-test-utils.js";

const NOW = "2026-06-18T12:00:00.000Z";

type Store = OpenTestPrisma["db"];
type Prisma = OpenTestPrisma["prisma"];

async function persistBatch(prisma: Prisma, rawBatch: unknown): Promise<void> {
  await persistCodexOtelBatch({
    prisma,
    batch: parseCodexOtelBatch(rawBatch),
    now: NOW,
  });
}

function baseSpan(overrides: Record<string, unknown> = {}) {
  return {
    traceId: "trace-1",
    spanId: "span-1",
    sessionId: "otel-session",
    name: "codex.exec",
    startTime: "2026-06-18T12:00:00.000Z",
    endTime: "2026-06-18T12:00:00.125Z",
    durationMs: 125,
    status: CodexOtelSpanStatus.Ok,
    attributes: {},
    ...overrides,
  };
}

async function getSpanRow(
  store: Store,
  sessionId: string
): Promise<{ tool_name: string | null; name: string } | undefined> {
  const result = await store.query<{ tool_name: string | null; name: string }>(
    "SELECT tool_name, name FROM codex_trace_span WHERE session_id = $1",
    [sessionId]
  );
  return result.rows[0];
}

describe("persistCodexOtelBatch: empty batch called directly (not through the sqlite.ts pre-filter)", () => {
  it("no-ops without writing any session, span, or token row, and never touches the write queue", async () => {
    const queue = makeRecordingQueue();
    const { db: store, prisma, close } = await openTestPrisma(queue);
    try {
      await persistBatch(prisma, { spans: [], tokenUsage: [] });

      const sessions = await store.query(
        "SELECT id FROM sessions WHERE id = $1",
        ["otel-session"]
      );
      expect(sessions.rows.length).toBe(0);
      const spans = await store.query(
        "SELECT trace_id FROM codex_trace_span",
        []
      );
      expect(spans.rows.length).toBe(0);
      // The early return happens BEFORE `options.prisma.write(...)` — a
      // mutant that skips or empties the early return would still reach
      // `prisma.write` (with a no-op `$transaction([])`), which this would
      // catch even though the row assertions above cannot distinguish it.
      expect(queue.runs).toBe(0);
    } finally {
      await close();
    }
  });

  it("still writes token usage when spans is empty but tokenUsage is not (both sides of the && matter)", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await persistBatch(prisma, {
        spans: [],
        tokenUsage: [
          {
            sessionId: "otel-session",
            model: "gpt-5-codex",
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            observedAt: "2026-06-18T12:00:00.000Z",
          },
        ],
      });

      const usage = await store.query<{ model: string }>(
        "SELECT model FROM token_usage WHERE session_id = $1",
        ["otel-session"]
      );
      expect(usage.rows).toEqual([{ model: "gpt-5-codex" }]);
    } finally {
      await close();
    }
  });
});

describe("persistCodexOtelBatch: resolveToolName fallback chain", () => {
  it("falls back to attributes['codex.tool.name'] when span.toolName is absent", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await persistBatch(prisma, {
        spans: [
          baseSpan({
            attributes: { "codex.tool.name": "shell-exec" },
          }),
        ],
      });

      const row = await getSpanRow(store, "otel-session");
      expect(row?.tool_name).toBe("shell-exec");
    } finally {
      await close();
    }
  });

  it("falls back to attributes['tool.name'] when toolName and codex.tool.name are both absent", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await persistBatch(prisma, {
        spans: [
          baseSpan({
            attributes: { "tool.name": "apply_patch" },
          }),
        ],
      });

      const row = await getSpanRow(store, "otel-session");
      expect(row?.tool_name).toBe("apply_patch");
    } finally {
      await close();
    }
  });

  it("falls back to attributes['tool.name'] when codex.tool.name is an empty string", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await persistBatch(prisma, {
        spans: [
          baseSpan({
            attributes: { "codex.tool.name": "", "tool.name": "web_search" },
          }),
        ],
      });

      const row = await getSpanRow(store, "otel-session");
      expect(row?.tool_name).toBe("web_search");
    } finally {
      await close();
    }
  });

  it("resolves to null when toolName and both attribute fallbacks are absent", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await persistBatch(prisma, {
        spans: [baseSpan({ attributes: { "tool.name": "" } })],
      });

      const row = await getSpanRow(store, "otel-session");
      expect(row?.tool_name).toBeNull();
    } finally {
      await close();
    }
  });
});

describe("persistCodexOtelBatch: whitespace-only free-form text collapses under trim", () => {
  // The Zod contract's spanNameSchema chains `.trim().min(1)`, so a
  // whitespace-only `name` is rejected at parseCodexOtelBatch and never
  // reaches the writer. statusMessage has no `.min()`, so Zod's `.trim()`
  // transform lets a whitespace-only value survive parsing as `""` — but
  // sanitizeOptionalCodexOtelText's own `if (!value)` guard then short-circuits
  // on that empty string before ever calling sanitizePersistedCodexOtelText.
  // The only way to reach sanitizePersistedCodexOtelText's own post-trim
  // empty check (the branch this test targets) is a still-whitespace, still-
  // truthy string, which requires calling the writer directly with a
  // hand-built batch that bypasses parseCodexOtelBatch's trim transform.
  it("collapses a whitespace-only statusMessage to the null fallback after re-trimming", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await persistCodexOtelBatch({
        prisma,
        now: NOW,
        batch: {
          spans: [
            {
              ...baseSpan(),
              statusMessage: "   ",
              attributes: {},
              resourceAttributes: {},
            },
          ],
          tokenUsage: [],
        },
      });

      const row = await store.query<{ status_message: string | null }>(
        "SELECT status_message FROM codex_trace_span WHERE session_id = $1",
        ["otel-session"]
      );
      expect(row.rows[0]?.status_message).toBeNull();
    } finally {
      await close();
    }
  });

  // Zod's `statusMessageSchema` already caps at CODEX_OTEL_MAX_STATUS_MESSAGE_LENGTH,
  // so no in-process caller can hand the writer a longer value — this is a
  // belt-and-braces backstop exercised the same way as the test above, by
  // calling the writer directly and bypassing parseCodexOtelBatch.
  it("truncates a statusMessage longer than the max at write time (defense in depth behind the Zod cap)", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      const overLong = "y".repeat(CODEX_OTEL_MAX_STATUS_MESSAGE_LENGTH + 10);
      await persistCodexOtelBatch({
        prisma,
        now: NOW,
        batch: {
          spans: [
            {
              ...baseSpan(),
              statusMessage: overLong,
              attributes: {},
              resourceAttributes: {},
            },
          ],
          tokenUsage: [],
        },
      });

      const row = await store.query<{ status_message: string | null }>(
        "SELECT status_message FROM codex_trace_span WHERE session_id = $1",
        ["otel-session"]
      );
      expect(row.rows[0]?.status_message?.length).toBe(
        CODEX_OTEL_MAX_STATUS_MESSAGE_LENGTH
      );
    } finally {
      await close();
    }
  });
});

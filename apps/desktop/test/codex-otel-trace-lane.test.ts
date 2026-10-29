/**
 * ISS-10719 — the Codex trace-span persist lane, end to end through the WIRED
 * receiver.
 *
 * Before this lane a Codex export was received, logged, and thrown away, so
 * every Codex tool call stayed a point event and every bar drawn for one was an
 * inferred upper bound forever. Persisting the spans is the half this lane
 * lands; the extent resolution that reads them back ships with the renderer
 * that consumes it.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { OtlpExportKind } from "../src/main/otlp/proto-descriptor.js";
import { OtlpHttpReceiver } from "../src/main/telemetry/otlp-http-receiver.js";
import { createOtlpExportCallbacks } from "../src/main/telemetry/otlp-receiver-wiring.js";
import {
  encodePayload,
  postOtlp,
  withDeadline,
} from "./helpers/claude-code-otel-fixtures.js";

const SESSION_ID = "codex-otel-wired-session";
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SPAN_ID = "0123456789abcdef";
const TOOL_NAME = "shell";
const SPAN_START = "2026-06-18T19:00:00.000Z";
const SPAN_END = "2026-06-18T19:00:02.500Z";
const SPAN_DURATION_MS = 2500;

function unixNano(iso: string): string {
  return (BigInt(Date.parse(iso)) * 1_000_000n).toString();
}

function attribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function codexSpanPayload(overrides: Record<string, unknown> = {}): Buffer {
  return encodePayload(OtlpExportKind.Traces, {
    resourceSpans: [
      {
        resource: {
          attributes: [attribute("service.name", "codex-cli")],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: Buffer.from(TRACE_ID, "hex"),
                spanId: Buffer.from(SPAN_ID, "hex"),
                name: "codex.tool.shell",
                startTimeUnixNano: unixNano(SPAN_START),
                endTimeUnixNano: unixNano(SPAN_END),
                status: { code: 1 },
                attributes: [
                  attribute("codex.session_id", SESSION_ID),
                  attribute("codex.tool_name", TOOL_NAME),
                ],
                ...overrides,
              },
            ],
          },
        ],
      },
    ],
  });
}

type WiredCodexReceiver = {
  receiver: OtlpHttpReceiver;
  port: number;
  persisted: (batches: number) => Promise<void>;
  dropsRecorded: (count: number) => Promise<void>;
};

async function openTestDatabase() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-otel-wired-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-18T20:00:00.000Z",
  });
  return {
    db,
    cleanup: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function startWiredCodexReceiver(
  db: Awaited<ReturnType<typeof openTestDatabase>>["db"],
  options: { failPersist?: boolean } = {}
): Promise<WiredCodexReceiver> {
  let completed = 0;
  let dropsWritten = 0;
  const waiters: (() => void)[] = [];
  const dropWaiters: (() => void)[] = [];
  const receiver = new OtlpHttpReceiver({
    port: 0,
    log: () => {
      // Diagnostics are not the contract under test.
    },
    onBindError: (reason) => {
      throw new Error(`OTLP receiver failed to bind: ${reason}`);
    },
    ...createOtlpExportCallbacks({
      log: () => {
        // Diagnostics are not the contract under test.
      },
      isClaudeCaptureEnabled: () => true,
      persistClaudeSignals: () => Promise.resolve({ accepted: 0, rejected: 0 }),
      recordSignalDrop: async (input) => {
        try {
          await db.claudeCodeOtel.recordSignalDrop(input);
        } finally {
          dropsWritten += 1;
          for (const resolve of dropWaiters.splice(0)) {
            resolve();
          }
        }
      },
      persistCodexBatch: async (batch) => {
        try {
          if (options.failPersist) {
            throw new Error("simulated write-boundary failure");
          }
          await db.codexOtel.persistBatch(batch);
        } finally {
          completed += 1;
          for (const resolve of waiters.splice(0)) {
            resolve();
          }
        }
      },
    }),
  });
  const state = await receiver.start();
  if (!state.available) {
    throw new Error("OTLP receiver unavailable");
  }
  return {
    receiver,
    port: state.port,
    persisted: async (batches: number) => {
      while (completed < batches) {
        await withDeadline(
          new Promise<void>((resolve) => waiters.push(resolve)),
          `no Codex OTel batch reached persistence (${completed}/${batches})`
        );
      }
    },
    dropsRecorded: async (count: number) => {
      while (dropsWritten < count) {
        await withDeadline(
          new Promise<void>((resolve) => dropWaiters.push(resolve)),
          `no Codex drop reached the counter (${dropsWritten}/${count})`
        );
      }
    },
  };
}

async function readSpans(
  db: Awaited<ReturnType<typeof openTestDatabase>>["db"]
): Promise<Record<string, unknown>[]> {
  return await db.prisma.client.$queryRawUnsafe<Record<string, unknown>[]>(
    "SELECT * FROM codex_trace_span ORDER BY span_id ASC"
  );
}

test("ISS-10719: a Codex trace export reaches codex_trace_span", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    const { receiver, port, persisted } = await startWiredCodexReceiver(db);
    try {
      const response = await postOtlp(port, "/v1/traces", codexSpanPayload());
      assert.equal(response.status, 200);
      await persisted(1);
    } finally {
      await receiver.stop();
    }

    const rows = await readSpans(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.trace_id, TRACE_ID);
    assert.equal(rows[0]?.span_id, SPAN_ID);
    assert.equal(rows[0]?.session_id, SESSION_ID);
    assert.equal(rows[0]?.tool_name, TOOL_NAME);
    // The extent is the whole point: a start AND an end, which no Codex
    // transcript records.
    assert.equal(Number(rows[0]?.duration_ms), SPAN_DURATION_MS);
  } finally {
    await cleanup();
  }
});

test("ISS-10719: a re-sent export upserts on (trace_id, span_id) rather than doubling", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    const { receiver, port, persisted } = await startWiredCodexReceiver(db);
    try {
      // An OTLP exporter re-sends a batch it did not see ACKed, so the same
      // span arrives twice in normal operation.
      for (const _ of [0, 1]) {
        const response = await postOtlp(port, "/v1/traces", codexSpanPayload());
        assert.equal(response.status, 200);
      }
      await persisted(2);
    } finally {
      await receiver.stop();
    }

    assert.equal((await readSpans(db)).length, 1);
  } finally {
    await cleanup();
  }
});

test("ISS-10719: a span with no resolvable session is refused, not given one", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    const { receiver, port } = await startWiredCodexReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/traces",
        codexSpanPayload({
          attributes: [attribute("codex.tool_name", TOOL_NAME)],
        })
      );
      assert.equal(response.status, 200);
    } finally {
      await receiver.stop();
    }

    // `session_id` FKs to `sessions.id`; a row written under an invented one
    // would attach a real measurement to the wrong session.
    assert.deepEqual(await readSpans(db), []);
  } finally {
    await cleanup();
  }
});

test("ISS-10722: a Codex write-boundary failure is COUNTED, not swallowed", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    const { receiver, port, dropsRecorded } = await startWiredCodexReceiver(
      db,
      { failPersist: true }
    );
    try {
      // The Codex writer commits the whole batch in one transaction, and the
      // export was ACKed long ago, so a failure here is permanent loss the
      // exporter will never re-send. Reaching only a log line would let the
      // completeness counter report the machine as clean while spans vanished.
      const response = await postOtlp(port, "/v1/traces", codexSpanPayload());
      assert.equal(response.status, 200);
      await dropsRecorded(1);
    } finally {
      await receiver.stop();
    }

    const rows = await db.prisma.client.$queryRawUnsafe<
      Record<string, unknown>[]
    >("SELECT * FROM claude_code_signal_drop");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.reason, "persistence_rejected");
    assert.equal(rows[0]?.harness, "codex");
    assert.equal(Number(rows[0]?.dropped_count), 1);
    assert.deepEqual(await readSpans(db), []);
  } finally {
    await cleanup();
  }
});

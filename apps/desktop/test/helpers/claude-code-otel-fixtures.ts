/**
 * Shared fixtures for the Claude Code OTel receiver tests.
 *
 * Two suites drive the same wired receiver — `claude-code-otel-receiver-
 * persistence.test.ts` (does an export reach the right table at all) and
 * `claude-code-otel-normalization-integrity.test.ts` (is the value it writes
 * truthful). The OTLP encoders, the temp database, and the wired-receiver
 * harness are identical for both, so they live here instead of being copied.
 */

import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { openSqliteAgentDatabase } from "../../src/main/database/sqlite.js";
import { ClaudeCodeOtelAttributeKey } from "../../src/main/otel/claude-code-otel-attributes.js";
import { ClaudeCodeOtelEventName } from "../../src/main/otel/claude-code-otel-log-signals.js";
import type { ClaudeCodeOtelTableName } from "../../src/main/otel/claude-code-otel-signal-contract.js";
import type { ClaudeCodeOtelPersistenceSummary } from "../../src/main/otel/claude-code-persistence.js";
import {
  getOtlpRequestType,
  OtlpExportKind,
} from "../../src/main/otlp/proto-descriptor.js";
import {
  type NormalizedOtlpExport,
  OtlpHarness,
  OtlpHttpReceiver,
} from "../../src/main/telemetry/otlp-http-receiver.js";
import { DEFAULT_OTLP_RECEIVER_HOST } from "../../src/main/telemetry/otlp-receiver-state.js";
import { createOtlpExportCallbacks } from "../../src/main/telemetry/otlp-receiver-wiring.js";

export const NOW = "2026-06-18T19:30:00.000Z";
export const SESSION_ID = "claude-otel-wired-session";
export const MODEL = "claude-sonnet-4-5";
export const TOOL_NAME = "Bash";
export const SERVICE_NAME = "claude-code";
export const COST_OBSERVED_AT = "2026-06-18T19:00:00.000Z";
export const API_REQUEST_AT = "2026-06-18T19:00:05.000Z";
export const API_REQUEST_DURATION_MS = 2500;
export const API_REQUEST_STARTED_AT = "2026-06-18T19:00:02.500Z";
export const TOOL_DECISION_AT = "2026-06-18T19:00:07.000Z";
export const PROTOBUF_CONTENT_TYPE = "application/x-protobuf";
export const PERSIST_DEADLINE_MS = 15_000;

/**
 * Sentinel planted in every content-bearing attribute Claude Code can stamp on
 * an export (prompt/response text, tool inputs, error strings, the user's email
 * and IdP groups, and the log record body). Nothing carrying it may reach a
 * normalized signal.
 */
export const CONTENT_SENTINEL = "SENSITIVE-PROMPT-TEXT-DO-NOT-PERSIST";

export type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;
export type SideTable = Exclude<
  ClaudeCodeOtelTableName,
  typeof ClaudeCodeOtelTableName.TokenUsage
>;
export type OtlpAttributeValue = string | number | boolean;

export type WiredReceiver = {
  receiver: OtlpHttpReceiver;
  port: number;
  settled: (batches: number) => Promise<void>;
  persistCalls: () => number;
  gateReads: () => number;
  /** What each completed batch's persister reported, in completion order. */
  summaries: () => readonly ClaudeCodeOtelPersistenceSummary[];
  /**
   * ISS-10717: resolves once `n` drop recordings have been WRITTEN. The wiring
   * fires the recorder without awaiting it — an export must not wait on the
   * bookkeeping about it — so a test that read the counter table straight after
   * the POST would race the write.
   */
  dropsRecorded: (count: number) => Promise<void>;
};

export async function startWiredReceiver(
  db: SqliteDb,
  captureEnabled = true
): Promise<WiredReceiver> {
  let completed = 0;
  let invoked = 0;
  let gateReads = 0;
  let dropsWritten = 0;
  const summaries: ClaudeCodeOtelPersistenceSummary[] = [];
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
      isClaudeCaptureEnabled: () => {
        gateReads += 1;
        return captureEnabled;
      },
      persistClaudeSignals: async (signals) => {
        // Counted BEFORE the await: `completed` only tells you a write
        // FINISHED, so asserting `completed === 0` for the gate-off case would
        // also pass on a write that merely had not landed yet.
        invoked += 1;
        try {
          const summary = await db.claudeCodeOtel.persistSignals(signals);
          summaries.push(summary);
          return summary;
        } finally {
          completed += 1;
          for (const resolve of waiters.splice(0)) {
            resolve();
          }
        }
      },
      recordSignalDrop: (input) => {
        // The write is not awaited here for the same reason production does not
        // await it: an export must never wait on the bookkeeping about it.
        const written = db.claudeCodeOtel.recordSignalDrop(input);
        written.finally(() => {
          dropsWritten += 1;
          for (const resolve of dropWaiters.splice(0)) {
            resolve();
          }
        });
      },
    }),
  });
  const state = await receiver.start();
  if (!state.available) {
    throw new Error(`OTLP receiver unavailable: ${state.reason}`);
  }
  return {
    receiver,
    port: state.port,
    persistCalls: () => invoked,
    gateReads: () => gateReads,
    summaries: () => summaries,
    // Bounded wait for OCCURRENCE: the receiver ACKs before dispatching, so
    // the write is still in flight when the POST resolves. The explicit bound
    // makes "nothing was ever persisted" fail here, naming the contract,
    // instead of silently consuming the runner's whole default timeout.
    settled: async (batches: number) => {
      while (completed < batches) {
        await withDeadline(
          new Promise<void>((resolve) => waiters.push(resolve)),
          `no Claude Code OTel batch reached persistence (${completed}/${batches})`
        );
      }
    },
    dropsRecorded: async (count: number) => {
      while (dropsWritten < count) {
        await withDeadline(
          new Promise<void>((resolve) => dropWaiters.push(resolve)),
          `no Claude Code OTel drop reached the counter (${dropsWritten}/${count})`
        );
      }
    },
  };
}

export function withDeadline(
  promise: Promise<void>,
  message: string
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), PERSIST_DEADLINE_MS);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** The attributes an api_request event needs, minus its token counts. */
export function apiRequestAttributesFor(
  model: string
): Record<string, OtlpAttributeValue> {
  return {
    [ClaudeCodeOtelAttributeKey.EventName]: ClaudeCodeOtelEventName.ApiRequest,
    [ClaudeCodeOtelAttributeKey.EventTimestamp]: API_REQUEST_AT,
    [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
    [ClaudeCodeOtelAttributeKey.Model]: model,
    [ClaudeCodeOtelAttributeKey.CostUsd]: 1.75,
    [ClaudeCodeOtelAttributeKey.DurationMs]: API_REQUEST_DURATION_MS,
  };
}

/** A decoded Claude logs export, as the receiver hands one to the normalizer. */
export function claudeLogExportOf(body: Buffer): NormalizedOtlpExport {
  return {
    kind: OtlpExportKind.Logs,
    harness: OtlpHarness.Claude,
    resourceAttributes: [],
    metricNames: [],
    logSummaries: [],
    spanSummaries: [],
    decodedPayload: decodePayload(OtlpExportKind.Logs, body),
  };
}

/** A decoded Claude traces export, as the receiver hands one to the normalizer. */
export function claudeTraceExportOf(body: Buffer): NormalizedOtlpExport {
  return {
    kind: OtlpExportKind.Traces,
    harness: OtlpHarness.Claude,
    resourceAttributes: [],
    metricNames: [],
    logSummaries: [],
    spanSummaries: [],
    decodedPayload: decodePayload(OtlpExportKind.Traces, body),
  };
}

/** A decoded Claude metrics export, as the receiver hands one to the normalizer. */
export function claudeMetricExportOf(body: Buffer): NormalizedOtlpExport {
  return {
    kind: OtlpExportKind.Metrics,
    harness: OtlpHarness.Claude,
    resourceAttributes: [],
    metricNames: [],
    logSummaries: [],
    spanSummaries: [],
    decodedPayload: decodePayload(OtlpExportKind.Metrics, body),
  };
}

export type CounterPoint = {
  value: number;
  observedAt: string;
  attributes: Record<string, OtlpAttributeValue>;
  /**
   * Sends the value through the `as_double` oneof member regardless of the
   * int-vs-double choice below. Every double big enough to overflow a sum is
   * also integer-valued, so that choice would put it in an `as_int` no int64
   * can hold; a corrupt-magnitude case has to say which member the wire
   * actually carries.
   */
  forceDouble?: boolean;
};

/**
 * One Claude Code counter metric, encoded to protobuf exactly as the exporter
 * sends it. Encoded and decoded rather than hand-built so the test exercises the
 * field naming and long-encoding the real decode applies (ISS-7352).
 */
export function encodeCounterPoints(
  metricName: string,
  points: CounterPoint[],
  aggregationTemporality: number
): Buffer {
  return encodePayload(OtlpExportKind.Metrics, {
    resourceMetrics: [
      {
        resource: { attributes: encodeAttributes(resourceAttributes()) },
        scopeMetrics: [
          {
            metrics: [
              {
                name: metricName,
                sum: {
                  isMonotonic: true,
                  aggregationTemporality,
                  // `as_int` vs `as_double` is chosen the way a real exporter
                  // chooses it, so a fractional value reaches the normalizer
                  // through the oneof member that can actually carry one.
                  dataPoints: points.map((point) => ({
                    timeUnixNano: unixNano(point.observedAt),
                    ...(Number.isInteger(point.value) && !point.forceDouble
                      ? { asInt: point.value }
                      : { asDouble: point.value }),
                    attributes: encodeAttributes(point.attributes),
                  })),
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

/**
 * Claude Code's beta span tier, encoded to protobuf exactly as the exporter
 * sends it. Encoded and decoded rather than hand-built so a test exercises the
 * real bytes-to-hex trace/span id decode and the `arrayValue` AnyValue that
 * `gen_ai.response.finish_reasons` arrives in.
 */
export function encodeSpans(spans: object[]): Buffer {
  return encodePayload(OtlpExportKind.Traces, {
    resourceSpans: [
      {
        resource: { attributes: encodeAttributes(resourceAttributes()) },
        scopeSpans: [{ spans }],
      },
    ],
  });
}

export function encodeLogRecords(logRecords: object[]): Buffer {
  return encodePayload(OtlpExportKind.Logs, {
    resourceLogs: [
      {
        resource: { attributes: encodeAttributes(resourceAttributes()) },
        scopeLogs: [{ logRecords }],
      },
    ],
  });
}

export function resourceAttributes(): Record<string, OtlpAttributeValue> {
  return { "service.name": SERVICE_NAME };
}

export function encodePayload(kind: OtlpExportKind, payload: object): Buffer {
  const type = getOtlpRequestType(kind);
  return Buffer.from(type.encode(type.create(payload)).finish());
}

export function decodePayload(
  kind: OtlpExportKind,
  buffer: Buffer
): Record<string, unknown> {
  const type = getOtlpRequestType(kind);
  return type.toObject(type.decode(buffer), {
    bytes: Buffer,
    longs: String,
    defaults: false,
  }) as Record<string, unknown>;
}

export function encodeAttributes(
  attributes: Record<string, OtlpAttributeValue>
) {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: anyValueFor(value),
  }));
}

export function anyValueFor(
  value: OtlpAttributeValue
): Record<string, unknown> {
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
}

export function unixNano(iso: string): string {
  return (BigInt(Date.parse(iso)) * 1_000_000n).toString();
}

export async function openTestDatabase(): Promise<{
  db: SqliteDb;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "claude-otel-wired-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  return {
    db,
    cleanup: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function seedSession(db: SqliteDb): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
     VALUES ($1, 'completed', $2, $2, 'claude', 'metered_api')`,
    SESSION_ID,
    "2026-06-18T18:00:00.000Z"
  );
}

export async function selectRows(
  db: SqliteDb,
  tableName: SideTable
): Promise<Record<string, unknown>[]> {
  return await db.prisma.client.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM ${tableName} ORDER BY id ASC`
  );
}

export async function countRows(
  db: SqliteDb,
  tableName: SideTable
): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ count: number }[]>(
    `SELECT COUNT(*) as count FROM ${tableName}`
  );
  return Number(rows[0]?.count ?? 0);
}

export function postOtlp(
  port: number,
  pathname: string,
  body: Buffer
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: DEFAULT_OTLP_RECEIVER_HOST,
        port,
        path: pathname,
        method: "POST",
        headers: {
          "Content-Length": body.length,
          "Content-Type": PROTOBUF_CONTENT_TYPE,
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}

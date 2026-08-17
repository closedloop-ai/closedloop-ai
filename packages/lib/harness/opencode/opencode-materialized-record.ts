/**
 * @file opencode-materialized-record.ts
 * @description SHARED record-schema module (FEA-3932) for the materialized
 * OpenCode transcript projection. OpenCode is a BATCH harness: its canonical
 * store is a foreign `opencode.db` SQLite file, which the byte-delta transcript
 * archive lane cannot upload directly. Instead the desktop materializer parses
 * the DB into `NormalizedSession`s and writes a deterministic, line-delimited
 * JSON projection (`main.jsonl` + `subagent:<id>.jsonl`); the cloud renderer
 * reads that projection back into a `NormalizedSession`.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the per-line record shape,
 * imported by BOTH the desktop materializer (writer) and the cloud parser core
 * (reader) so the producer and consumer can never drift. It is intentionally a
 * LEAF, BROWSER-SAFE module:
 *   - no `node:*` imports (it must bundle into the renderer);
 *   - only depends on `zod` and the leaf harness `types.ts` contract.
 *
 * Wire format: every line is exactly one JSON object with a discriminant
 * `t` field (record kind). The first line is always the `session` header
 * carrying the scalar/aggregate session fields; the remaining lines are the
 * per-message / per-tool-use / per-token / per-error / per-turn records in
 * emission order. Redaction (`redactJsonlTranscriptByteChunks`) and the archive
 * lane's newline-boundary streaming both require exactly-one-object-per-line,
 * newline-terminated, so per-message granularity keeps each line small.
 *
 * Cross-repo/skew: reader tolerance is deliberate. An unknown `t` value or a
 * record that fails its member schema is SKIPPED (never throws) so a newer
 * writer that adds a record kind or field degrades gracefully on an older
 * reader — the session still renders from the records the reader understands.
 * New fields are additive and optional; absent optionals are omitted (never
 * serialized as `null`).
 */
import { z } from "zod";
import type {
  NormalizedApiError,
  NormalizedDiffStats,
  NormalizedMessage,
  NormalizedTokenRecord,
  NormalizedToolResultError,
  NormalizedToolUse,
  NormalizedTurnDuration,
} from "../types";

/** Current materialized-projection schema version (bumped on breaking shape changes). */
export const OPENCODE_MATERIALIZED_SCHEMA_VERSION = 1;

/** Discriminant `t` values for the materialized JSONL record kinds. */
export const OpencodeMaterializedRecordKind = {
  Session: "session",
  Message: "message",
  ToolUse: "toolUse",
  Token: "token",
  ApiError: "apiError",
  ToolError: "toolError",
  TurnDuration: "turnDuration",
} as const;
export type OpencodeMaterializedRecordKind =
  (typeof OpencodeMaterializedRecordKind)[keyof typeof OpencodeMaterializedRecordKind];

/** Full fresh-shape token counts (session-level `tokensByModel` values). */
const fullTokenCountsSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
});

/** Per-message token counts — `cacheRead`/`cacheWrite` optional (NormalizedMessage.tokens). */
const messageTokenCountsSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
});

const diffStatsSchema = z.object({
  filesChanged: z.number(),
  linesAdded: z.number(),
  linesRemoved: z.number(),
});

/**
 * The `session` header record — the first line of every materialized file.
 * Carries the scalar/aggregate session fields the renderer needs; the ordered
 * per-message/tool/token records follow. `tokensByModel` and `diffStats` are the
 * session-level aggregates the parser cannot re-derive from the child records
 * (OpenCode reports them on the session row), so they ride on the header.
 */
export const opencodeSessionRecordSchema = z.object({
  t: z.literal(OpencodeMaterializedRecordKind.Session),
  v: z.number(),
  sessionId: z.string(),
  name: z.string(),
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  version: z.string().nullable(),
  slug: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  userMessages: z.number(),
  assistantMessages: z.number(),
  thinkingBlockCount: z.number(),
  permissionMode: z.string().nullable(),
  entrypoint: z.string(),
  fileModifiedAt: z.number().nullable(),
  tokensByModel: z.record(z.string(), fullTokenCountsSchema),
  messageTimestamps: z.array(z.string()),
  diffStats: diffStatsSchema.nullable(),
});
export type OpencodeSessionRecord = z.infer<typeof opencodeSessionRecordSchema>;

const opencodeMessageRecordSchema = z.object({
  t: z.literal(OpencodeMaterializedRecordKind.Message),
  role: z.enum(["human", "assistant", "system"]),
  timestamp: z.string().nullable(),
  text: z.string().nullable(),
  model: z.string().nullable().optional(),
  tokens: messageTokenCountsSchema.optional(),
  isThinking: z.boolean().optional(),
  isSynthetic: z.boolean().optional(),
});
export type OpencodeMessageRecord = z.infer<typeof opencodeMessageRecordSchema>;

const opencodeToolUseRecordSchema = z.object({
  t: z.literal(OpencodeMaterializedRecordKind.ToolUse),
  name: z.string(),
  timestamp: z.string().nullable(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  isError: z.boolean().optional(),
  diffDelta: z.object({ add: z.number(), del: z.number() }).optional(),
});
export type OpencodeToolUseRecord = z.infer<typeof opencodeToolUseRecordSchema>;

const opencodeTokenRecordSchema = z.object({
  t: z.literal(OpencodeMaterializedRecordKind.Token),
  timestamp: z.string(),
  model: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
});
export type OpencodeTokenRecord = z.infer<typeof opencodeTokenRecordSchema>;

const opencodeApiErrorRecordSchema = z.object({
  t: z.literal(OpencodeMaterializedRecordKind.ApiError),
  type: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
  timestamp: z.string().nullable(),
});
export type OpencodeApiErrorRecord = z.infer<
  typeof opencodeApiErrorRecordSchema
>;

const opencodeToolErrorRecordSchema = z.object({
  t: z.literal(OpencodeMaterializedRecordKind.ToolError),
  content: z.string().nullable().optional(),
  timestamp: z.string().nullable(),
});
export type OpencodeToolErrorRecord = z.infer<
  typeof opencodeToolErrorRecordSchema
>;

const opencodeTurnDurationRecordSchema = z.object({
  t: z.literal(OpencodeMaterializedRecordKind.TurnDuration),
  durationMs: z.number(),
  timestamp: z.string().nullable(),
});
export type OpencodeTurnDurationRecord = z.infer<
  typeof opencodeTurnDurationRecordSchema
>;

/**
 * A single materialized line record. The reader validates each parsed line
 * against this union; an unknown `t` or a member-schema failure is skipped by
 * the parser (never thrown) so a newer writer degrades gracefully.
 */
export const opencodeMaterializedRecordSchema = z.discriminatedUnion("t", [
  opencodeSessionRecordSchema,
  opencodeMessageRecordSchema,
  opencodeToolUseRecordSchema,
  opencodeTokenRecordSchema,
  opencodeApiErrorRecordSchema,
  opencodeToolErrorRecordSchema,
  opencodeTurnDurationRecordSchema,
]);
export type OpencodeMaterializedRecord = z.infer<
  typeof opencodeMaterializedRecordSchema
>;

/**
 * Omit absent optional fields entirely (never `null` for an optional). Serialize
 * a value only when it is not `undefined`; `null` is preserved verbatim for the
 * fields whose contract is genuinely nullable (e.g. `text`, `model`).
 */
function withDefined<T extends Record<string, unknown>>(record: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

/** Build the `session` header record from a parsed session's scalar/aggregate fields. */
export function buildOpencodeSessionRecord(input: {
  sessionId: string;
  name: string;
  cwd: string | null;
  model: string | null;
  version: string | null;
  slug: string | null;
  startedAt: string | null;
  endedAt: string | null;
  userMessages: number;
  assistantMessages: number;
  thinkingBlockCount: number;
  permissionMode: string | null;
  entrypoint: string;
  fileModifiedAt: number | null;
  tokensByModel: OpencodeSessionRecord["tokensByModel"];
  messageTimestamps: string[];
  diffStats: NormalizedDiffStats | null;
}): OpencodeSessionRecord {
  return {
    t: OpencodeMaterializedRecordKind.Session,
    v: OPENCODE_MATERIALIZED_SCHEMA_VERSION,
    ...input,
  };
}

/** Build a `message` record from a `NormalizedMessage`. */
export function buildOpencodeMessageRecord(
  message: NormalizedMessage
): OpencodeMessageRecord {
  return withDefined({
    t: OpencodeMaterializedRecordKind.Message,
    role: message.role,
    timestamp: message.timestamp,
    text: message.text,
    model: message.model,
    tokens: message.tokens,
    isThinking: message.isThinking,
    isSynthetic: message.isSynthetic,
  });
}

/** Build a `toolUse` record from a `NormalizedToolUse`. */
export function buildOpencodeToolUseRecord(
  toolUse: NormalizedToolUse
): OpencodeToolUseRecord {
  return withDefined({
    t: OpencodeMaterializedRecordKind.ToolUse,
    name: toolUse.name,
    timestamp: toolUse.timestamp,
    input: toolUse.input,
    output: toolUse.output,
    isError: toolUse.isError,
    diffDelta: toolUse.diffDelta,
  });
}

/** Build a `token` record from a `NormalizedTokenRecord`. */
export function buildOpencodeTokenRecord(
  token: NormalizedTokenRecord
): OpencodeTokenRecord {
  return {
    t: OpencodeMaterializedRecordKind.Token,
    timestamp: token.timestamp,
    model: token.model,
    input: token.input,
    output: token.output,
    cacheRead: token.cacheRead,
    cacheWrite: token.cacheWrite,
  };
}

/** Build an `apiError` record from a `NormalizedApiError`. */
export function buildOpencodeApiErrorRecord(
  error: NormalizedApiError
): OpencodeApiErrorRecord {
  return withDefined({
    t: OpencodeMaterializedRecordKind.ApiError,
    type: error.type,
    message: error.message,
    timestamp: error.timestamp,
  });
}

/** Build a `toolError` record from a `NormalizedToolResultError`. */
export function buildOpencodeToolErrorRecord(
  error: NormalizedToolResultError
): OpencodeToolErrorRecord {
  return withDefined({
    t: OpencodeMaterializedRecordKind.ToolError,
    content: error.content,
    timestamp: error.timestamp,
  });
}

/** Build a `turnDuration` record from a `NormalizedTurnDuration`. */
export function buildOpencodeTurnDurationRecord(
  turn: NormalizedTurnDuration
): OpencodeTurnDurationRecord {
  return {
    t: OpencodeMaterializedRecordKind.TurnDuration,
    durationMs: turn.durationMs,
    timestamp: turn.timestamp,
  };
}

/**
 * Parse one JSONL line into a validated record, or `null` when the line is
 * blank, not valid JSON, carries an unknown `t`, or fails its member schema.
 * NEVER throws — a malformed or forward-incompatible line is skipped so the rest
 * of the session still renders (cross-repo skew tolerance).
 */
export function parseOpencodeMaterializedLine(
  line: string
): OpencodeMaterializedRecord | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = opencodeMaterializedRecordSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/** Serialize a record to its single JSONL line (no trailing newline). */
export function serializeOpencodeMaterializedRecord(
  record: OpencodeMaterializedRecord
): string {
  return JSON.stringify(record);
}

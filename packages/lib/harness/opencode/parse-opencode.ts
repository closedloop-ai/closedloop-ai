/**
 * @file parse-opencode.ts
 * @description Cloud-side parser (FEA-3932) for the MATERIALIZED OpenCode
 * transcript projection. OpenCode's canonical store is a foreign `opencode.db`
 * SQLite file that the desktop main process parses (`collectors/opencode`) and
 * the materializer (`transcript-sync/opencode-materializer.ts`) projects into a
 * line-delimited JSON file. This core reads that projection back into the same
 * `NormalizedSession` shape the DB importer produces, so the cloud-rendered
 * OpenCode transcript and the DB-backed one agree.
 *
 * It consumes the SHARED record schema (`opencode-materialized-record.ts`),
 * imported by both the writer and this reader so producer/consumer cannot drift.
 * Browser-safe: no `node:*`; only `zod` (via the schema) and the leaf harness
 * contract. Reads a sync/async line iterable (mirrors `parseClaudeTranscript` /
 * `parseCodexRollout`) so it slots into the same streaming cloud-fetch path.
 *
 * Contract parity with the other cloud parsers: returns `null` when the file
 * carries no usable timestamp (no `session` header with a `startedAt`), so
 * `importSession`/the renderer treat all harnesses identically. Malformed or
 * forward-incompatible lines are skipped (never thrown) for cross-repo skew.
 */
import {
  createNormalizedSession,
  Harness,
  type NormalizedApiError,
  type NormalizedMessage,
  type NormalizedSession,
  type NormalizedTokenRecord,
  type NormalizedToolResultError,
  type NormalizedToolUse,
  type NormalizedTurnDuration,
} from "../types";
import {
  OpencodeMaterializedRecordKind,
  type OpencodeSessionRecord,
  parseOpencodeMaterializedLine,
} from "./opencode-materialized-record";

/** Options for {@link parseOpenCodeTranscript} (mirrors the other cores). */
export type ParseOpenCodeTranscriptOptions = {
  /** Stable session id (already `opencode-<id>`); overrides the header's own. */
  sessionId?: string;
};

type OpencodeAccumulator = {
  header: OpencodeSessionRecord | null;
  messages: NormalizedMessage[];
  toolUses: NormalizedToolUse[];
  tokenSeries: NormalizedTokenRecord[];
  apiErrors: NormalizedApiError[];
  toolResultErrors: NormalizedToolResultError[];
  turnDurations: NormalizedTurnDuration[];
};

function createAccumulator(): OpencodeAccumulator {
  return {
    header: null,
    messages: [],
    toolUses: [],
    tokenSeries: [],
    apiErrors: [],
    toolResultErrors: [],
    turnDurations: [],
  };
}

/**
 * Build a `NormalizedSession` from the accumulated records. Returns `null` when
 * no `session` header with a usable `startedAt` was seen — the vendor contract
 * shared by every cloud parser.
 */
function finalize(
  acc: OpencodeAccumulator,
  sessionIdOverride: string | undefined
): NormalizedSession | null {
  const header = acc.header;
  if (!header?.startedAt) {
    return null;
  }
  return createNormalizedSession({
    sessionId: sessionIdOverride ?? header.sessionId,
    name: header.name,
    cwd: header.cwd,
    model: header.model,
    version: header.version,
    slug: header.slug,
    startedAt: header.startedAt,
    endedAt: header.endedAt ?? header.startedAt,
    userMessages: header.userMessages,
    assistantMessages: header.assistantMessages,
    thinkingBlockCount: header.thinkingBlockCount,
    permissionMode: header.permissionMode,
    entrypoint: header.entrypoint || Harness.OpenCode,
    fileModifiedAt: header.fileModifiedAt,
    tokensByModel: header.tokensByModel,
    messageTimestamps: header.messageTimestamps,
    diffStats: header.diffStats,
    messages: acc.messages,
    toolUses: acc.toolUses,
    tokenSeries: acc.tokenSeries,
    apiErrors: acc.apiErrors,
    toolResultErrors: acc.toolResultErrors,
    turnDurations: acc.turnDurations,
  });
}

function applyRecord(
  acc: OpencodeAccumulator,
  record: NonNullable<ReturnType<typeof parseOpencodeMaterializedLine>>
): void {
  switch (record.t) {
    case OpencodeMaterializedRecordKind.Session:
      // The first header wins; a materialized file has exactly one.
      acc.header ??= record;
      break;
    case OpencodeMaterializedRecordKind.Message:
      acc.messages.push({
        role: record.role,
        timestamp: record.timestamp,
        text: record.text,
        model: record.model,
        tokens: record.tokens,
        ...(record.isThinking ? { isThinking: true } : {}),
        ...(record.isSynthetic ? { isSynthetic: true } : {}),
      });
      break;
    case OpencodeMaterializedRecordKind.ToolUse:
      acc.toolUses.push({
        name: record.name,
        timestamp: record.timestamp,
        ...(record.input === undefined ? {} : { input: record.input }),
        ...(record.output === undefined ? {} : { output: record.output }),
        ...(record.isError ? { isError: true } : {}),
        ...(record.diffDelta ? { diffDelta: record.diffDelta } : {}),
      });
      break;
    case OpencodeMaterializedRecordKind.Token:
      acc.tokenSeries.push({
        timestamp: record.timestamp,
        model: record.model,
        input: record.input,
        output: record.output,
        cacheRead: record.cacheRead,
        cacheWrite: record.cacheWrite,
      });
      break;
    case OpencodeMaterializedRecordKind.ApiError:
      acc.apiErrors.push({
        type: record.type,
        message: record.message,
        timestamp: record.timestamp,
      });
      break;
    case OpencodeMaterializedRecordKind.ToolError:
      acc.toolResultErrors.push({
        content: record.content,
        timestamp: record.timestamp,
      });
      break;
    case OpencodeMaterializedRecordKind.TurnDuration:
      acc.turnDurations.push({
        durationMs: record.durationMs,
        timestamp: record.timestamp,
      });
      break;
    default:
      break;
  }
}

/**
 * Parse a materialized OpenCode transcript (sync/async iterable of JSONL lines)
 * into a `NormalizedSession`. Returns `null` when the projection carries no
 * `session` header with a usable timestamp.
 */
export async function parseOpenCodeTranscript(
  lines: AsyncIterable<string> | Iterable<string>,
  options: ParseOpenCodeTranscriptOptions = {}
): Promise<NormalizedSession | null> {
  const acc = createAccumulator();
  for await (const line of lines) {
    const record = parseOpencodeMaterializedLine(line);
    if (record) {
      applyRecord(acc, record);
    }
  }
  return finalize(acc, options.sessionId);
}

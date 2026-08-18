/**
 * @file parse-cursor.ts
 * @description Pure, browser-safe Cursor agent-transcript parser core. Cursor's
 * background-agent transcripts use a format similar to Codex rollouts — each line
 * is a JSON record with a `type`, `payload`, and `timestamp` — and the parser is
 * intentionally tolerant of format drift across Cursor versions.
 *
 * FEA-3710 (Parser roadmap 4): extracted verbatim from the desktop
 * `apps/desktop/.../cursor/cursor-parser.ts` so a single parser core can run
 * from every surface — one normalized result, no surface-dependent semantics.
 * Today it is consumed by the desktop DB importer and the shared tests; this
 * extraction is also the groundwork for cloud/browser transcript rendering,
 * which does not yet route Cursor through this core (the cloud renderer's
 * `isCloudParseableHarness` still covers only Claude and Codex — FEA-2717).
 * Ported from the vendor `scripts/agent-monitor-cursor/cursor-parser.js`; all
 * parsing/token math (non-cumulative, last value wins) and timestamp handling
 * preserved exactly.
 *
 * This module consumes a JSONL *line iterable* (the desktop shell streams a file
 * via `readline`; a future cloud renderer would split a fetched string) and
 * never touches local disk. The two DB-import-specific pieces that need Node —
 * deriving the session id from the transcript path and stamping the source-file
 * mtime — stay in the desktop shell, mirroring the Claude/Codex cores (FEA-2717).
 */
import {
  baseName,
  collectArtifacts,
  isMeaningfulCwd,
  isSyntheticModelKey,
  noteTimestamp,
  pushTurnDuration,
  safeJson,
  truncateText,
} from "../parser-utils";
import { readStorageTokenCountAlias } from "../token-counts";
import type {
  NormalizedApiError,
  NormalizedMessage,
  NormalizedSession,
  NormalizedTokenRecord,
  NormalizedToolResultError,
  NormalizedToolUse,
  NormalizedTurnDuration,
} from "../types";
import { createNormalizedSession, emptyArtifacts } from "../types";

/**
 * Coerce a value to a plain object record, falling back to `{}` (never `null`).
 * The tolerant Cursor parser reads untyped JSON and always wants an indexable
 * record — this is the `{}`-fallback variant, deliberately distinct from the
 * `null`-returning `asRecord` in `../type-guards`. Excludes arrays so an array
 * payload is treated as "no fields", matching the pre-extraction desktop parser.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Read a string-or-null field tolerantly (Cursor records are untyped JSON). */
function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Read a numeric field tolerantly. */
function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

// Canonical fresh shape (see NormalizedTokenCounts): Cursor reports per-turn
// `input_tokens` as FRESH/uncached with cache_read/cache_write as separate
// additive fields, so they are read verbatim — no subtraction.
function readCursorTokenCounts(
  info: Record<string, unknown>,
  context: string
): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  return {
    input: readStorageTokenCountAlias(info, `${context}.input`, [
      "input_tokens",
      "prompt_tokens",
    ]),
    output: readStorageTokenCountAlias(info, `${context}.output`, [
      "output_tokens",
      "completion_tokens",
    ]),
    cacheRead: readStorageTokenCountAlias(info, `${context}.cache_read`, [
      "cache_read_tokens",
      "cached_input_tokens",
    ]),
    cacheWrite: readStorageTokenCountAlias(info, `${context}.cache_write`, [
      "cache_write_tokens",
      "cache_creation_input_tokens",
    ]),
  };
}

/**
 * The single mutable accumulator threaded through every per-line handler. The
 * event-type dispatch map below keys on a record's `type` (and its aliases) and
 * shares this one object, replacing the former multi-alias if-cascade —
 * parseTranscriptFile was a per-session hot path with ~40 cyclomatic paths.
 */
type CursorAccumulator = {
  cwd: string | null;
  model: string | null;
  version: string | null;
  gitBranch: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  userMessageCount: number;
  assistantMessageCount: number;
  messageTimestamps: string[];
  toolUses: NormalizedToolUse[];
  turnDurations: NormalizedTurnDuration[];
  apiErrors: NormalizedApiError[];
  thinkingBlockCount: number;
  toolResultErrors: NormalizedToolResultError[];
  tokenInput: number;
  tokenOutput: number;
  tokenCacheRead: number;
  tokenCacheWrite: number;
  pendingTurnStartedAt: string | null;
  // CR-1: Ordered messages with text content
  messages: NormalizedMessage[];
  // CR-2: Per-event token records for time-series
  tokenSeries: NormalizedTokenRecord[];
  // CR-5: Track per-turn model from turn_context
  currentTurnModel: string | null;
};

function createAccumulator(): CursorAccumulator {
  return {
    cwd: null,
    model: null,
    version: null,
    gitBranch: null,
    firstTimestamp: null,
    lastTimestamp: null,
    userMessageCount: 0,
    assistantMessageCount: 0,
    messageTimestamps: [],
    toolUses: [],
    turnDurations: [],
    apiErrors: [],
    thinkingBlockCount: 0,
    toolResultErrors: [],
    tokenInput: 0,
    tokenOutput: 0,
    tokenCacheRead: 0,
    tokenCacheWrite: 0,
    pendingTurnStartedAt: null,
    messages: [],
    tokenSeries: [],
    currentTurnModel: null,
  };
}

/** One per-line handler keyed by event `type` in CURSOR_EVENT_HANDLERS. */
type CursorHandler = (
  acc: CursorAccumulator,
  payload: Record<string, unknown>,
  iso: string | null,
  type: string
) => void;

/** Cursor `message` records carry the speaker in either `role` or `author`. */
function isMessageRole(
  payload: Record<string, unknown>,
  role: "user" | "assistant"
): boolean {
  return payload.role === role || payload.author === role;
}

// CR-3: a tool result is an error when explicitly flagged, when it reports a
// failing (positive) exit code, or when it carries a populated error field.
function isToolResultError(payload: Record<string, unknown>): boolean {
  const exitCode = asNumberOrNull(payload.exit_code);
  return (
    payload.is_error === true ||
    payload.success === false ||
    (exitCode != null && exitCode > 0) ||
    !!payload.error
  );
}

// Session metadata
const handleSessionMeta: CursorHandler = (acc, payload) => {
  if (!acc.cwd) {
    const candidate =
      asStringOrNull(payload.cwd) ??
      asStringOrNull(payload.workdir) ??
      asStringOrNull(payload.workspace);
    if (isMeaningfulCwd(candidate)) {
      acc.cwd = candidate;
    }
  }
  if (!acc.version) {
    acc.version =
      asStringOrNull(payload.version) ??
      asStringOrNull(payload.cli_version) ??
      asStringOrNull(payload.cursor_version);
  }
  if (!acc.model) {
    acc.model = asStringOrNull(payload.model);
  }
  if (!acc.gitBranch) {
    if (typeof payload.git === "object" && payload.git) {
      const git = payload.git as Record<string, unknown>;
      acc.gitBranch = asStringOrNull(git.branch) ?? asStringOrNull(git.ref);
    } else if (payload.git_branch) {
      acc.gitBranch = asStringOrNull(payload.git_branch);
    }
  }
};

// Model override (turn-level is authoritative) — CR-5: also track per-turn model
const handleTurnContext: CursorHandler = (acc, payload) => {
  if (payload.model) {
    acc.model = asStringOrNull(payload.model);
    acc.currentTurnModel = acc.model;
  }
  if (!acc.cwd && payload.cwd) {
    const candidate = asStringOrNull(payload.cwd);
    if (isMeaningfulCwd(candidate)) {
      acc.cwd = candidate;
    }
  }
};

// User messages — CR-1: capture message text
const handleUserMessage: CursorHandler = (acc, payload, iso) => {
  acc.userMessageCount++;
  if (iso) {
    acc.pendingTurnStartedAt = iso;
  }
  const rawText =
    asStringOrNull(payload.content) ??
    asStringOrNull(payload.text) ??
    asStringOrNull(payload.message);
  const msgModel = acc.currentTurnModel ?? acc.model;
  const cursorResolved = msgModel || "cursor-default";
  acc.messages.push({
    role: "human",
    timestamp: iso,
    text: truncateText(rawText),
    model: msgModel,
    ...(isSyntheticModelKey(cursorResolved) ? { isSynthetic: true } : {}),
  });
};

// Assistant messages — CR-1: capture message text
const handleAssistantMessage: CursorHandler = (acc, payload, iso) => {
  acc.assistantMessageCount++;
  if (iso) {
    acc.messageTimestamps.push(iso);
  }
  pushTurnDuration(acc.turnDurations, acc.pendingTurnStartedAt, iso);
  acc.pendingTurnStartedAt = null;
  const rawText =
    asStringOrNull(payload.content) ?? asStringOrNull(payload.text);
  const msgModel = acc.currentTurnModel ?? acc.model;
  const cursorResolved = msgModel || "cursor-default";
  acc.messages.push({
    role: "assistant",
    timestamp: iso,
    text: truncateText(rawText),
    model: msgModel,
    ...(isSyntheticModelKey(cursorResolved) ? { isSynthetic: true } : {}),
  });
};

// Thinking/reasoning
const handleReasoning: CursorHandler = (acc) => {
  acc.thinkingBlockCount++;
};

// Tool calls
const handleToolCall: CursorHandler = (acc, payload, iso) => {
  acc.toolUses.push({
    name:
      asStringOrNull(payload.name) ??
      asStringOrNull(payload.tool_name) ??
      asStringOrNull(payload.command_name) ??
      "tool",
    timestamp: iso || acc.firstTimestamp,
    input: safeJson(
      payload.arguments == null ? payload.input : payload.arguments
    ),
  });
};

// File edits (Cursor-specific)
const handleFileEdit: CursorHandler = (acc, payload, iso) => {
  acc.toolUses.push({
    name: "file_edit",
    timestamp: iso || acc.firstTimestamp,
    input: payload.file || payload.path || null,
  });
};

// Resolve the raw output text of a tool-result payload, preferring a string
// `output`, then a string `content`, then a JSON-serialized `result` — matching
// the pre-extraction desktop parser exactly. Kept as a flat if-cascade (not a
// nested ternary) so the tolerant fallbacks stay readable.
function resolveToolResultOutput(
  payload: Record<string, unknown>
): string | null {
  if (typeof payload.output === "string") {
    return payload.output;
  }
  if (typeof payload.content === "string") {
    return payload.content;
  }
  if (payload.result == null) {
    return null;
  }
  return JSON.stringify(payload.result);
}

// Tool results — CR-3: capture output content and error status
const handleToolResult: CursorHandler = (acc, payload, iso) => {
  const isErr = isToolResultError(payload);
  if (isErr) {
    const content =
      typeof payload.output === "string"
        ? payload.output.slice(0, 500)
        : JSON.stringify(payload.error || payload.output || payload).slice(
            0,
            500
          );
    acc.toolResultErrors.push({ content, timestamp: iso });
  }

  // CR-3: Attach output + isError to the most recent tool use
  const lastTool = acc.toolUses.length > 0 ? acc.toolUses.at(-1) : null;
  if (lastTool) {
    lastTool.output = truncateText(resolveToolResultOutput(payload), 4096);
    if (isErr) {
      lastTool.isError = true;
    }
  }
};

// Token usage — CR-2: push per-event token record for time-series
const handleTokenCount: CursorHandler = (acc, payload, iso) => {
  const info = asRecord(payload.usage ?? payload.token_count ?? payload);
  const tokens = readCursorTokenCounts(info, "cursor.usage");
  acc.tokenInput = tokens.input;
  acc.tokenOutput = tokens.output;
  acc.tokenCacheRead = tokens.cacheRead;
  acc.tokenCacheWrite = tokens.cacheWrite;
  if (payload.model) {
    acc.model = asStringOrNull(payload.model);
  }

  // CR-2: Record this token event for time-series reconstruction
  const tokenTs = iso || acc.lastTimestamp || acc.firstTimestamp;
  if (tokenTs) {
    acc.tokenSeries.push({
      timestamp: tokenTs,
      model: acc.currentTurnModel ?? acc.model ?? "cursor-default",
      input: acc.tokenInput,
      output: acc.tokenOutput,
      cacheRead: acc.tokenCacheRead,
      cacheWrite: acc.tokenCacheWrite,
    });
  }
};

// Errors
const handleError: CursorHandler = (acc, payload, iso, type) => {
  acc.apiErrors.push({
    type,
    message:
      (typeof payload.message === "string" && payload.message) ||
      asStringOrNull(payload.error) ||
      "Cursor error",
    timestamp: iso,
  });
};

/**
 * Event-type → handler dispatch. Each alias of a logical event maps to the same
 * handler; a record's `type` selects at most one handler, all writing the shared
 * accumulator. The former cascade ran one `if` per category per line; this is a
 * single map lookup. The two predicate-gated cases — `message` role
 * disambiguation and the untyped session-metadata fallback — stay inline in the
 * loop because they cannot be keyed by `type` alone.
 *
 * A `Map` (not a plain object) is deliberate: `type` is untrusted JSON, so an
 * object lookup would resolve inherited keys like `"constructor"` or
 * `"__proto__"` to non-handler prototype members — `Map.get` only ever returns
 * a value we put in, matching the old cascade's "unknown type → no-op".
 */
const CURSOR_EVENT_HANDLERS = new Map<string, CursorHandler>([
  ["session_meta", handleSessionMeta],
  ["session.created", handleSessionMeta],
  ["session_start", handleSessionMeta],
  ["turn_context", handleTurnContext],
  ["turn.context", handleTurnContext],
  ["model_context", handleTurnContext],
  ["user_message", handleUserMessage],
  ["human_message", handleUserMessage],
  ["assistant_message", handleAssistantMessage],
  ["agent_message", handleAssistantMessage],
  ["reasoning", handleReasoning],
  ["thinking", handleReasoning],
  ["agent_reasoning", handleReasoning],
  ["tool_call", handleToolCall],
  ["function_call", handleToolCall],
  ["tool_use", handleToolCall],
  ["command_execution", handleToolCall],
  ["terminal_command", handleToolCall],
  ["file_edit", handleFileEdit],
  ["apply_edit", handleFileEdit],
  ["code_edit", handleFileEdit],
  ["tool_result", handleToolResult],
  ["tool_output", handleToolResult],
  ["command_output", handleToolResult],
  ["token_count", handleTokenCount],
  ["usage", handleTokenCount],
  ["token_usage", handleTokenCount],
  ["error", handleError],
  ["api_error", handleError],
  ["stream_error", handleError],
]);

/**
 * Process one raw JSONL line into the shared accumulator. Malformed JSON,
 * non-object records, and blank lines are skipped (the vendor's tolerant
 * contract). Kept separate from the driver loop so the per-line dispatch — a
 * handler-map lookup plus the two predicate-gated cases that cannot be keyed by
 * `type` alone — stays within the cognitive-complexity budget.
 */
function processCursorLine(
  acc: CursorAccumulator,
  line: string,
  noteTs: (raw: unknown) => string | null
): void {
  if (!line.trim()) {
    return;
  }
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  if (!rec || typeof rec !== "object") {
    return;
  }

  const record = rec as Record<string, unknown>;
  const ts = record.timestamp || record.ts || record.created_at || null;
  const iso = noteTs(ts);
  const type = typeof record.type === "string" ? record.type : "";
  const payload = asRecord(record.payload ?? record.data ?? record);

  const handler = CURSOR_EVENT_HANDLERS.get(type);
  if (handler) {
    handler(acc, payload, iso, type);
    return;
  }
  if (type === "message") {
    // A `message` record names its speaker via role/author; dispatch to one or
    // both handlers exactly as the former dual if-cascade did.
    if (isMessageRole(payload, "user")) {
      handleUserMessage(acc, payload, iso, type);
    }
    if (isMessageRole(payload, "assistant")) {
      handleAssistantMessage(acc, payload, iso, type);
    }
    return;
  }
  if (!type && (payload.cwd || payload.workdir || payload.workspace)) {
    // Untyped record that still looks like session metadata.
    handleSessionMeta(acc, payload, iso, type);
  }
}

/** Assemble the final NormalizedSession from a fully-consumed accumulator. */
function buildCursorSession(
  acc: CursorAccumulator,
  sessionId: string
): NormalizedSession {
  const tokensByModel: NormalizedSession["tokensByModel"] = {};
  if (
    acc.tokenInput ||
    acc.tokenOutput ||
    acc.tokenCacheRead ||
    acc.tokenCacheWrite
  ) {
    const key = acc.model || "cursor-default";
    tokensByModel[key] = {
      input: acc.tokenInput,
      output: acc.tokenOutput,
      cacheRead: acc.tokenCacheRead,
      cacheWrite: acc.tokenCacheWrite,
    };
  }

  const projectName = acc.cwd
    ? baseName(acc.cwd)
    : `Cursor Session ${sessionId.slice(0, 8)}`;

  // CR-13: Extract artifact references (PRs, issues, repo) from tool calls
  const artifacts =
    acc.toolUses.length > 0
      ? collectArtifacts(acc.toolUses, acc.cwd)
      : emptyArtifacts();

  // Unset fields are filled by createNormalizedSession's defaults. The desktop
  // shell stamps the source-file mtime; the cloud renderer has no local file,
  // so the core leaves `fileModifiedAt` alone.
  return createNormalizedSession({
    sessionId,
    name: projectName,
    cwd: acc.cwd,
    model: acc.model,
    version: acc.version,
    gitBranch: acc.gitBranch,
    startedAt: acc.firstTimestamp,
    endedAt: acc.lastTimestamp,
    userMessages: acc.userMessageCount,
    assistantMessages: acc.assistantMessageCount,
    tokensByModel,
    messageTimestamps: acc.messageTimestamps,
    toolUses: acc.toolUses,
    apiErrors: acc.apiErrors,
    turnDurations: acc.turnDurations,
    entrypoint: "cursor",
    thinkingBlockCount: acc.thinkingBlockCount,
    toolResultErrors: acc.toolResultErrors,
    // CR-1: Ordered messages with text content
    messages: acc.messages,
    // CR-2: Per-event token records for time-series
    tokenSeries: acc.tokenSeries,
    // CR-13: Structured artifact references
    artifacts,
  });
}

/**
 * Parse a Cursor agent transcript from a JSONL line iterable into a
 * NormalizedSession. Returns null when the transcript carries no usable
 * timestamp (matching the vendor contract). The desktop shell derives
 * `sessionId` from the transcript path and stamps the source-file mtime; the
 * cloud renderer supplies the session id from its descriptor and has no local
 * file, so neither concern belongs in this pure core.
 */
export async function parseCursorTranscript(
  lines: AsyncIterable<string> | Iterable<string>,
  options: { sessionId: string }
): Promise<NormalizedSession | null> {
  const sessionId = options.sessionId;
  const acc = createAccumulator();
  const noteTs = (raw: unknown): string | null => noteTimestamp(acc, raw);

  for await (const line of lines) {
    processCursorLine(acc, line, noteTs);
  }

  if (!acc.firstTimestamp) {
    return null;
  }

  return buildCursorSession(acc, sessionId);
}

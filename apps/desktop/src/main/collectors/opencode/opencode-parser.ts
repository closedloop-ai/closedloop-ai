/**
 * @file opencode-parser.ts
 * @description Parse OpenCode session data from `opencode.db` into the
 * normalized session shape consumed by `importSession`. OpenCode persists its
 * canonical session/message/part model in SQLite; `storage/` is auxiliary
 * cache/snapshot state and is not authoritative for session history.
 *
 * OpenCode is a BATCH harness: this reads the whole foreign `opencode.db` in
 * one load. Ported from `scripts/agent-monitor-opencode/opencode-parser.js`
 * (logic preserved exactly); the foreign DB is opened with `node:sqlite`'s
 * `DatabaseSync`.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  addStorageTokenCounts,
  readStorageTokenCount,
  readStorageTokenCountAlias,
} from "../../token-counts.js";
import {
  collectArtifacts,
  computeUnifiedDiffDelta,
  countDiffFiles,
  extractErrorMessage,
  isSyntheticModelKey,
  noteTimestamp,
  pushTurnDuration,
  safeJson,
  toIso,
  truncateText,
} from "../parsing/parser-utils.js";
import {
  createNormalizedSession,
  type NormalizedApiError,
  type NormalizedDiffStats,
  type NormalizedMessage,
  type NormalizedSession,
  type NormalizedTokenCounts,
  type NormalizedTokenRecord,
  type NormalizedToolResultError,
  type NormalizedToolUse,
  type NormalizedTurnDuration,
} from "../types.js";
import { getOpenCodeDbPath } from "./opencode-home.js";

type Row = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJsonCell(value: unknown): unknown {
  return typeof value === "string" ? safeJson(value) : value;
}

// Canonical fresh shape (see NormalizedTokenCounts): OpenCode reports `input`
// as FRESH/uncached with cache_read/cache_write as separate additive fields, so
// they are read verbatim — no subtraction.
function extractTokenCounts(
  raw: Record<string, unknown>,
  context: string
): NormalizedTokenCounts | null {
  const input = readStorageTokenCountAlias(raw, `${context}.input`, [
    "input",
    "inputTokens",
    "input_tokens",
    "prompt_tokens",
    "tokens_input",
  ]);
  const output = addStorageTokenCounts(
    readStorageTokenCountAlias(raw, `${context}.output`, [
      "output",
      "outputTokens",
      "output_tokens",
      "completion_tokens",
      "tokens_output",
    ]),
    readStorageTokenCountAlias(raw, `${context}.reasoning`, [
      "reasoning",
      "reasoningTokens",
      "reasoning_tokens",
      "reasoning_output_tokens",
      "tokens_reasoning",
    ]),
    `${context}.output_with_reasoning`
  );
  const cacheRead = readStorageTokenCountAlias(raw, `${context}.cache_read`, [
    "cacheRead",
    "cache_read",
    "cacheReadTokens",
    "cache_read_tokens",
    "cached_input_tokens",
    "tokens_cache_read",
  ]);
  const cacheWrite = readStorageTokenCountAlias(raw, `${context}.cache_write`, [
    "cacheWrite",
    "cache_write",
    "cacheWriteTokens",
    "cache_write_tokens",
    "cache_creation_input_tokens",
    "tokens_cache_creation",
    "tokens_cache_write",
  ]);
  if (input || output || cacheRead || cacheWrite) {
    return { input, output, cacheRead, cacheWrite };
  }
  return null;
}

function modelIdFromValue(value: unknown): string | null {
  const parsed = parseJsonCell(value);
  if (isObject(parsed)) {
    const modelID = parsed.modelID;
    const id = parsed.id;
    const name = parsed.name;
    return (
      (typeof modelID === "string" ? modelID : null) ||
      (typeof id === "string" ? id : null) ||
      (typeof name === "string" ? name : null) ||
      null
    );
  }
  return typeof parsed === "string" && parsed.length > 0 ? parsed : null;
}

function partTimestamp(partRow: Row, part: Record<string, unknown>): unknown {
  const time = isObject(part.time) ? part.time : undefined;
  return (
    time?.created ??
    time?.start ??
    partRow.time_created ??
    partRow.time_updated ??
    null
  );
}

/** CR-2: Extract per-message token counts from the message data JSON. */
function extractMessageTokens(
  data: Record<string, unknown>
): NormalizedTokenCounts | null {
  // OpenCode stores tokens in data.tokens as an object or JSON string.
  const raw = parseJsonCell(data.tokens);
  if (!isObject(raw)) {
    return null;
  }
  return extractTokenCounts(raw, "opencode.message_tokens");
}

function collectToolUse(
  toolUses: NormalizedToolUse[],
  toolResultErrors: NormalizedToolResultError[],
  partRow: Row,
  part: Record<string, unknown>,
  firstTimestamp: string | null
): void {
  const timestamp = toIso(partTimestamp(partRow, part)) || firstTimestamp;
  const state = isObject(part.state) ? part.state : undefined;
  const input = state?.input ?? part.input ?? part.parameters ?? null;
  const status = state?.status;
  const stateOutput = state?.output;

  // CR-3: Capture output for all completions (success and error).
  let output: unknown;
  let isError = false;
  const errorMessage = extractErrorMessage(state?.error ?? part.error);

  if (status === "failed" || status === "error" || errorMessage) {
    isError = true;
    const outputStr =
      typeof stateOutput === "string"
        ? stateOutput
        : JSON.stringify(stateOutput ?? part.state ?? part).slice(0, 500);
    output = truncateText(
      errorMessage || outputStr || "OpenCode tool error",
      4096
    );
    toolResultErrors.push({
      content: (errorMessage || outputStr || "OpenCode tool error").slice(
        0,
        500
      ),
      timestamp,
    });
  } else if (stateOutput != null) {
    // CR-3: Successful tool output — truncate at 4KB.
    const outputStr =
      typeof stateOutput === "string"
        ? stateOutput
        : JSON.stringify(stateOutput);
    output = truncateText(outputStr, 4096);
  }

  toolUses.push({
    name:
      (typeof part.tool === "string" ? part.tool : null) ||
      (typeof part.name === "string" ? part.name : null) ||
      "opencode_tool",
    timestamp,
    input: safeJson(input),
    output,
    isError: isError || undefined,
  });
}

/**
 * Mutable accumulator shared by the message-row and part-row handlers. Keeping
 * all per-session state on one object lets the role/part-type handler
 * registries stay small, single-responsibility functions instead of branches
 * inside one mega-loop.
 */
type SessionAccumulator = {
  readonly sessionModel: string | null;
  cwd: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  userMessageCount: number;
  assistantMessageCount: number;
  pendingTurnStartedAt: string | null;
  thinkingBlockCount: number;
  totalAdded: number;
  totalRemoved: number;
  totalFilesChanged: number;
  readonly messageTimestamps: string[];
  readonly toolUses: NormalizedToolUse[];
  readonly turnDurations: NormalizedTurnDuration[];
  readonly apiErrors: NormalizedApiError[];
  readonly toolResultErrors: NormalizedToolResultError[];
  readonly messages: NormalizedMessage[];
  readonly tokenSeries: NormalizedTokenRecord[];
  // FEA-2958: IDs of messages that already contributed a message-level token
  // entry (pushMessageTokenSeries). OpenCode reports the same usage again on the
  // message's step-finish parts, so those are skipped for these messages to keep
  // token_events — and the Dashboard cost analytics that SUM over it — from
  // double-counting. Session-level token_usage is unaffected (it derives from the
  // session-row aggregate, not this series).
  readonly tokenSeriesMessageIds: Set<string>;
};

/** Per-message context resolved once before role dispatch. */
type MessageContext = {
  iso: string | null;
  msgModel: string | null;
  msgTokens: NormalizedTokenCounts | null;
  data: Record<string, unknown>;
  msgId: string | null;
};

/** Per-part context resolved once before part-type dispatch. */
type PartContext = {
  iso: string | null;
  partRow: Row;
  part: Record<string, unknown>;
};

/** Normalize an opencode row/JSON id (string | number | bigint | null) to a
 *  stable Set key, or null when absent. */
function messageIdKey(value: unknown): string | null {
  return value == null ? null : String(value);
}

// CR-2: Token series for a message (only when tokens, timestamp, and model are
// all present). Shared by the user and assistant role handlers.
function pushMessageTokenSeries(
  acc: SessionAccumulator,
  ctx: MessageContext
): void {
  if (ctx.msgTokens && ctx.iso && ctx.msgModel) {
    acc.tokenSeries.push({
      timestamp: ctx.iso,
      model: ctx.msgModel,
      input: ctx.msgTokens.input,
      output: ctx.msgTokens.output,
      cacheRead: ctx.msgTokens.cacheRead,
      cacheWrite: ctx.msgTokens.cacheWrite,
    });
    // FEA-2958: remember this message contributed a token entry so its
    // step-finish parts (which repeat the same usage) are not double-counted.
    if (ctx.msgId) {
      acc.tokenSeriesMessageIds.add(ctx.msgId);
    }
  }
}

function handleUserMessage(acc: SessionAccumulator, ctx: MessageContext): void {
  acc.userMessageCount++;
  if (ctx.iso) {
    acc.pendingTurnStartedAt = ctx.iso;
  }
  // CR-1: Build NormalizedMessage for user messages.
  // User message text is in data.content (string or array of parts).
  const userText = extractMessageText(ctx.data);
  acc.messages.push({
    role: "human",
    timestamp: ctx.iso,
    text: truncateText(userText),
    model: ctx.msgModel,
    tokens: ctx.msgTokens ?? undefined,
    ...(ctx.msgModel && isSyntheticModelKey(ctx.msgModel)
      ? { isSynthetic: true }
      : {}),
  });
  pushMessageTokenSeries(acc, ctx);
}

function handleAssistantMessage(
  acc: SessionAccumulator,
  ctx: MessageContext
): void {
  acc.assistantMessageCount++;
  if (ctx.iso) {
    acc.messageTimestamps.push(ctx.iso);
  }
  pushTurnDuration(acc.turnDurations, acc.pendingTurnStartedAt, ctx.iso);
  acc.pendingTurnStartedAt = null;
  // CR-1: Build NormalizedMessage for assistant messages.
  const assistantText = extractMessageText(ctx.data);
  acc.messages.push({
    role: "assistant",
    timestamp: ctx.iso,
    text: truncateText(assistantText),
    model: ctx.msgModel,
    tokens: ctx.msgTokens ?? undefined,
    ...(ctx.msgModel && isSyntheticModelKey(ctx.msgModel)
      ? { isSynthetic: true }
      : {}),
  });
  pushMessageTokenSeries(acc, ctx);
}

// Role aliases share one handler. Roles with no entry contribute no message
// (but still flow through the error capture in processMessageRows).
const messageRoleHandlers: Record<
  string,
  (acc: SessionAccumulator, ctx: MessageContext) => void
> = {
  user: handleUserMessage,
  human: handleUserMessage,
  assistant: handleAssistantMessage,
  ai: handleAssistantMessage,
  model: handleAssistantMessage,
};

function handleReasoningPart(acc: SessionAccumulator, ctx: PartContext): void {
  acc.thinkingBlockCount++;
  // CR-1: Thinking block as a message entry.
  acc.messages.push({
    role: "assistant",
    timestamp: ctx.iso,
    text: null,
    model: acc.sessionModel,
    isThinking: true,
    ...(acc.sessionModel && isSyntheticModelKey(acc.sessionModel)
      ? { isSynthetic: true }
      : {}),
  });
}

function handleTextPart(acc: SessionAccumulator, ctx: PartContext): void {
  // CR-1: Text parts contribute to messages. These are typically content
  // sub-parts within assistant turns.
  const part = ctx.part;
  const textContent =
    typeof part.text === "string"
      ? part.text
      : typeof part.content === "string"
        ? part.content
        : null;
  if (textContent) {
    acc.messages.push({
      role: "assistant",
      timestamp: ctx.iso,
      text: truncateText(textContent),
      model: acc.sessionModel,
      ...(acc.sessionModel && isSyntheticModelKey(acc.sessionModel)
        ? { isSynthetic: true }
        : {}),
    });
  }
}

function handleToolPart(acc: SessionAccumulator, ctx: PartContext): void {
  collectToolUse(
    acc.toolUses,
    acc.toolResultErrors,
    ctx.partRow,
    ctx.part,
    acc.firstTimestamp
  );
}

function handleErrorPart(acc: SessionAccumulator, ctx: PartContext): void {
  const errorMessage = extractErrorMessage(ctx.part);
  if (errorMessage) {
    acc.apiErrors.push({
      type: "error",
      message: errorMessage,
      timestamp: ctx.iso,
    });
  }
}

function handlePatchPart(acc: SessionAccumulator, ctx: PartContext): void {
  // CR-4: Patch parts contain unified diff data.
  const part = ctx.part;
  const patchContent =
    typeof part.content === "string"
      ? part.content
      : typeof part.patch === "string"
        ? part.patch
        : typeof part.diff === "string"
          ? part.diff
          : null;
  if (patchContent) {
    const delta = computeUnifiedDiffDelta(patchContent);
    acc.totalAdded += delta.add;
    acc.totalRemoved += delta.del;
    acc.totalFilesChanged += countDiffFiles(patchContent);
    // Attach diff delta to the most recent tool use if applicable.
    if (acc.toolUses.length > 0) {
      const lastTool = acc.toolUses.at(-1);
      if (lastTool && !lastTool.diffDelta) {
        lastTool.diffDelta = delta;
      }
    }
  }
}

function handleStepFinishPart(acc: SessionAccumulator, ctx: PartContext): void {
  // CR-2: Step-finish parts may contain per-step token data.
  const part = ctx.part;
  // FEA-2958: skip this step-finish's tokens when the owning message already
  // contributed a message-level entry (see the tokenSeriesMessageIds field
  // comment). OpenCode's message-level data.tokens is the cumulative per-message
  // total — the same usage these step-finish parts break down — so counting both
  // double-counts token_events. The owning message id lives in the part row's
  // `message_id` column (the FK that mirrors the message row's `id`, which the
  // dedup set is keyed on); real OpenCode parts do not repeat it in the JSON
  // `data` payload, so prefer the column and fall back to the JSON field only
  // for fixtures/shapes that carry it. When absent, dedup is skipped and
  // behavior is unchanged from before this fix.
  const messageId = messageIdKey(
    ctx.partRow.message_id ?? part.messageID ?? part.message_id
  );
  if (messageId && acc.tokenSeriesMessageIds.has(messageId)) {
    return;
  }
  const stepData = isObject(part.usage)
    ? part.usage
    : isObject(part.tokens)
      ? part.tokens
      : null;
  if (stepData && ctx.iso) {
    const stepModel =
      modelIdFromValue(part.model ?? part.modelID) ||
      acc.sessionModel ||
      "opencode-default";
    const tokens = extractTokenCounts(stepData, "opencode.step_tokens");
    if (tokens) {
      acc.tokenSeries.push({
        timestamp: ctx.iso,
        model: stepModel,
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
      });
    }
  }
}

// 6-way part.type cascade as a registry. step-finish has two spellings that
// share a handler.
const partTypeHandlers: Record<
  string,
  (acc: SessionAccumulator, ctx: PartContext) => void
> = {
  reasoning: handleReasoningPart,
  text: handleTextPart,
  tool: handleToolPart,
  error: handleErrorPart,
  patch: handlePatchPart,
  "step-finish": handleStepFinishPart,
  step_finish: handleStepFinishPart,
};

/** Resolve per-message model attribution and token counts (CR-5/CR-9/CR-2). */
function resolveMessageContext(
  acc: SessionAccumulator,
  row: Row,
  data: Record<string, unknown>
): MessageContext {
  const dataTime = isObject(data.time) ? data.time : undefined;
  const iso = noteTimestamp(
    acc,
    dataTime?.created ?? row.time_created ?? row.time_updated
  );

  // CR-5: Per-message modelID from data JSON.
  // CR-9: Also check data.tokens.modelID for per-message model attribution.
  const tokensObj = isObject(data.tokens)
    ? data.tokens
    : typeof data.tokens === "string"
      ? (parseJsonCell(data.tokens) as Record<string, unknown> | null)
      : null;
  const tokensModelID = isObject(tokensObj) ? tokensObj.modelID : undefined;
  const msgModel =
    modelIdFromValue(data.model ?? data.modelID ?? tokensModelID) ||
    acc.sessionModel;

  // CR-2: Per-message token counts.
  const msgTokens = extractMessageTokens(data);

  return { iso, msgModel, msgTokens, data, msgId: messageIdKey(row.id) };
}

/** Drive the message-row loop through the role handler registry. */
function processMessageRows(acc: SessionAccumulator, messageRows: Row[]): void {
  for (const row of messageRows) {
    const data = parseJsonCell(row.data);
    if (!isObject(data)) {
      continue;
    }

    const ctx = resolveMessageContext(acc, row, data);
    const role =
      (typeof data.role === "string" ? data.role : null) ||
      (typeof data.type === "string" ? data.type : null) ||
      "";

    if (!acc.cwd && isObject(data.path)) {
      const dataPath = data.path;
      const pathCwd = typeof dataPath.cwd === "string" ? dataPath.cwd : null;
      const pathRoot = typeof dataPath.root === "string" ? dataPath.root : null;
      acc.cwd = pathCwd || pathRoot || acc.cwd;
    }

    // Own-key lookup only: `role` is foreign opencode.db content, so a value
    // like "constructor"/"toString" must not resolve to an Object.prototype
    // method (the original cascade skipped any unrecognized role).
    if (Object.hasOwn(messageRoleHandlers, role)) {
      messageRoleHandlers[role](acc, ctx);
    }

    const errorMessage = extractErrorMessage(data.error);
    if (errorMessage) {
      acc.apiErrors.push({
        type: "error",
        message: errorMessage,
        timestamp: ctx.iso,
      });
    }
  }
}

/** Drive the part-row loop through the part-type handler registry. */
function processPartRows(acc: SessionAccumulator, partRows: Row[]): void {
  for (const partRow of partRows) {
    const part = parseJsonCell(partRow.data);
    if (!isObject(part)) {
      continue;
    }

    const iso = noteTimestamp(acc, partTimestamp(partRow, part));
    // Own-key lookup only, for the same prototype-pollution safety as the
    // role dispatch above (`part.type` is also foreign opencode.db content).
    if (
      typeof part.type === "string" &&
      Object.hasOwn(partTypeHandlers, part.type)
    ) {
      partTypeHandlers[part.type](acc, { iso, partRow, part });
    }
  }
}

/** CR-4/CR-9: Build aggregate diffStats. Prefer summary columns from the
 *  session row when available, fall back to patch-part accumulation. */
function resolveDiffStats(
  sessionRow: Row,
  hasSummaryCols: boolean,
  patch: { added: number; removed: number; filesChanged: number }
): NormalizedDiffStats | null {
  if (hasSummaryCols) {
    const summaryAdds = Number(sessionRow.summary_additions || 0);
    const summaryDels = Number(sessionRow.summary_deletions || 0);
    const summaryFiles = Number(sessionRow.summary_files || 0);
    // Parse summary_diffs for additional diff context (unified diff text).
    const summaryDiffsRaw = sessionRow.summary_diffs;
    if (typeof summaryDiffsRaw === "string" && summaryDiffsRaw.length > 0) {
      const diffDelta = computeUnifiedDiffDelta(summaryDiffsRaw);
      const diffFiles = countDiffFiles(summaryDiffsRaw);
      // Prefer summary_diffs line counts when they provide data and the
      // explicit summary columns are zeroed out; otherwise the explicit
      // columns are authoritative.
      const effectiveAdds = summaryAdds || diffDelta.add;
      const effectiveDels = summaryDels || diffDelta.del;
      const effectiveFiles = summaryFiles || diffFiles;
      if (effectiveAdds || effectiveDels || effectiveFiles) {
        return {
          filesChanged: effectiveFiles,
          linesAdded: effectiveAdds,
          linesRemoved: effectiveDels,
        };
      }
    } else if (summaryAdds || summaryDels || summaryFiles) {
      return {
        filesChanged: summaryFiles,
        linesAdded: summaryAdds,
        linesRemoved: summaryDels,
      };
    }
  }
  if (patch.added || patch.removed || patch.filesChanged) {
    return {
      filesChanged: patch.filesChanged,
      linesAdded: patch.added,
      linesRemoved: patch.removed,
    };
  }
  return null;
}

/** Build the per-model session-level token totals (5 token-column reads). */
function buildTokensByModel(
  sessionRow: Row,
  sessionModel: string | null
): Record<string, NormalizedTokenCounts> {
  const tokensByModel: Record<string, NormalizedTokenCounts> = {};
  const tokenInput = readStorageTokenCount(
    sessionRow.tokens_input,
    "opencode.session.input"
  );
  const tokenOutput = readStorageTokenCount(
    sessionRow.tokens_output,
    "opencode.session.output"
  );
  const tokenReasoning = readStorageTokenCount(
    sessionRow.tokens_reasoning,
    "opencode.session.reasoning"
  );
  const tokenCacheRead = readStorageTokenCount(
    sessionRow.tokens_cache_read,
    "opencode.session.cache_read"
  );
  const tokenCacheWrite = readStorageTokenCount(
    sessionRow.tokens_cache_write,
    "opencode.session.cache_write"
  );
  if (
    tokenInput ||
    tokenOutput ||
    tokenReasoning ||
    tokenCacheRead ||
    tokenCacheWrite
  ) {
    const agent =
      typeof sessionRow.agent === "string" ? sessionRow.agent : null;
    const key = sessionModel || agent || "opencode-default";
    tokensByModel[key] = {
      input: tokenInput,
      output: addStorageTokenCounts(
        tokenOutput,
        tokenReasoning,
        "opencode.session.output_with_reasoning"
      ),
      cacheRead: tokenCacheRead,
      cacheWrite: tokenCacheWrite,
    };
  }
  return tokensByModel;
}

function parseSessionRow(
  sessionRow: Row,
  getMessages: StatementSync,
  getParts: StatementSync,
  hasSummaryCols: boolean
): NormalizedSession | null {
  const sessionId = sessionRow.id as string | number | bigint | null;
  const messageRows = getMessages.all(sessionId) as Row[];
  if (!Array.isArray(messageRows) || messageRows.length === 0) {
    return null;
  }

  const acc: SessionAccumulator = {
    sessionModel: modelIdFromValue(sessionRow.model),
    cwd: typeof sessionRow.directory === "string" ? sessionRow.directory : null,
    firstTimestamp: null,
    lastTimestamp: null,
    userMessageCount: 0,
    assistantMessageCount: 0,
    pendingTurnStartedAt: null,
    thinkingBlockCount: 0,
    totalAdded: 0,
    totalRemoved: 0,
    totalFilesChanged: 0,
    messageTimestamps: [],
    toolUses: [],
    turnDurations: [],
    apiErrors: [],
    toolResultErrors: [],
    messages: [],
    tokenSeries: [],
    tokenSeriesMessageIds: new Set(),
  };

  noteTimestamp(acc, sessionRow.time_created);
  noteTimestamp(acc, sessionRow.time_updated);

  processMessageRows(acc, messageRows);
  processPartRows(acc, getParts.all(sessionId) as Row[]);

  if (!acc.firstTimestamp) {
    return null;
  }

  const tokensByModel = buildTokensByModel(sessionRow, acc.sessionModel);

  const diffStats = resolveDiffStats(sessionRow, hasSummaryCols, {
    added: acc.totalAdded,
    removed: acc.totalRemoved,
    filesChanged: acc.totalFilesChanged,
  });

  // CR-13: Collect artifact references from tool uses.
  const artifacts = collectArtifacts(acc.toolUses, acc.cwd);

  const sessionIdStr = String(sessionId);
  const title = typeof sessionRow.title === "string" ? sessionRow.title : null;
  const projectName = acc.cwd
    ? path.basename(acc.cwd)
    : title || `OpenCode Session ${sessionIdStr.slice(0, 8)}`;

  const version =
    typeof sessionRow.version === "string" ? sessionRow.version : null;
  const slug = typeof sessionRow.slug === "string" ? sessionRow.slug : null;
  const permissionMode =
    typeof sessionRow.permission === "string" ? sessionRow.permission : null;

  // Unset fields are filled by createNormalizedSession's defaults.
  return createNormalizedSession({
    sessionId: `opencode-${sessionIdStr}`,
    name: projectName,
    cwd: acc.cwd,
    model: acc.sessionModel,
    version,
    slug,
    startedAt: acc.firstTimestamp,
    endedAt: acc.lastTimestamp || acc.firstTimestamp,
    userMessages: acc.userMessageCount,
    assistantMessages: acc.assistantMessageCount,
    tokensByModel,
    messageTimestamps: acc.messageTimestamps,
    toolUses: acc.toolUses,
    apiErrors: acc.apiErrors,
    fileModifiedAt: Number(sessionRow.time_updated || 0) || null,
    turnDurations: acc.turnDurations,
    entrypoint: "opencode",
    permissionMode,
    thinkingBlockCount: acc.thinkingBlockCount,
    toolResultErrors: acc.toolResultErrors,
    messages: acc.messages,
    tokenSeries: acc.tokenSeries,
    diffStats,
    artifacts,
  });
}

/** Extract text content from a message data object. Handles both string and
 *  array-of-parts content shapes. */
function extractMessageText(data: Record<string, unknown>): string | null {
  const content = data.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        textParts.push(item);
      } else if (
        isObject(item) &&
        item.type === "text" &&
        typeof item.text === "string"
      ) {
        textParts.push(item.text);
      }
    }
    return textParts.length > 0 ? textParts.join("\n") : null;
  }
  // Fallback: try data.text directly.
  if (typeof data.text === "string") {
    return data.text;
  }
  return null;
}

/** CR-9: Detect whether the session table has summary_* columns. */
function hasSummaryColumns(db: DatabaseSync): boolean {
  try {
    const cols = db.prepare("PRAGMA table_info(session)").all() as Row[];
    const names = new Set(cols.map((c) => c.name));
    return (
      names.has("summary_additions") &&
      names.has("summary_deletions") &&
      names.has("summary_files") &&
      names.has("summary_diffs")
    );
  } catch {
    return false;
  }
}

export function loadSessionsFromDb(
  dbPath: string = getOpenCodeDbPath()
): NormalizedSession[] {
  if (!(dbPath && fs.existsSync(dbPath))) {
    return [];
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1000");

    // CR-9: Detect optional summary columns before building the SELECT.
    const hasSummaryCols = hasSummaryColumns(db);

    const sessionSelect = hasSummaryCols
      ? `
        SELECT
          id,
          slug,
          directory,
          title,
          version,
          agent,
          model,
          permission,
          time_created,
          time_updated,
          tokens_input,
          tokens_output,
          tokens_reasoning,
          tokens_cache_read,
          tokens_cache_write,
          summary_additions,
          summary_deletions,
          summary_files,
          summary_diffs
        FROM session
        ORDER BY time_updated DESC, id DESC
      `
      : `
        SELECT
          id,
          slug,
          directory,
          title,
          version,
          agent,
          model,
          permission,
          time_created,
          time_updated,
          tokens_input,
          tokens_output,
          tokens_reasoning,
          tokens_cache_read,
          tokens_cache_write
        FROM session
        ORDER BY time_updated DESC, id DESC
      `;

    const sessionRows = db.prepare(sessionSelect).all() as Row[];
    const getMessages = db.prepare(`
      SELECT id, time_created, time_updated, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created ASC, id ASC
    `);
    const getParts = db.prepare(`
      SELECT id, message_id, time_created, time_updated, data
      FROM part
      WHERE session_id = ?
      ORDER BY time_created ASC, id ASC
    `);

    const out: NormalizedSession[] = [];
    for (const row of sessionRows) {
      const session = parseSessionRow(
        row,
        getMessages,
        getParts,
        hasSummaryCols
      );
      if (session) {
        out.push(session);
      }
    }
    return out;
  } finally {
    db.close();
  }
}

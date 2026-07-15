/**
 * @file copilot-parser.ts
 * @description Parse GitHub Copilot session data into the normalized session
 * object consumed by the collection layer. Handles two formats:
 *
 * 1. Copilot Chat (VS Code extension): JSON files with conversation turns
 * 2. Copilot CLI (`gh copilot`): JSONL event log files
 *
 * Both produce the same normalized shape so Copilot sessions render through
 * the unchanged dashboard UI.
 *
 * Ported from `scripts/agent-monitor-copilot/copilot-parser.js` (logic
 * preserved).
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { isRecord } from "../../../shared/type-guards.js";
import {
  addStorageTokenCounts,
  readStorageTokenCountAlias,
} from "../../token-counts.js";
import { coldReadGate } from "../parsing/cold-read-gate.js";
import {
  collectArtifacts,
  extractErrorMessage,
  isSyntheticModelKey,
  noteTimestamp,
  pushTurnDuration,
  safeJson,
  toIso,
  truncateText,
} from "../parsing/parser-utils.js";
import type {
  NormalizedApiError,
  NormalizedMessage,
  NormalizedSession,
  NormalizedTokenRecord,
  NormalizedToolUse,
  NormalizedTurnDuration,
} from "../types.js";
import { createNormalizedSession } from "../types.js";

/** Read a property off an unknown value without throwing. */
function get(value: unknown, key: string): unknown {
  if (isRecord(value)) {
    return value[key];
  }
  return undefined;
}

/**
 * CR-2: Resolve a usage object from a message/request/entry using the canonical
 * 5-way fallback (`usage` → `tokenUsage` → `token_count` → `response.usage` →
 * `result.usage`). Shared by the message loop, the raw-requests loop, and
 * `normalizeChatRequest` so the precedence is defined in exactly one place.
 */
function resolveUsageObject(
  source: Record<string, unknown>
): Record<string, unknown> | null {
  const usageInfo =
    source.usage ||
    source.tokenUsage ||
    source.token_count ||
    get(source.response, "usage") ||
    get(source.result, "usage") ||
    null;
  return usageInfo && typeof usageInfo === "object"
    ? (usageInfo as Record<string, unknown>)
    : null;
}

/**
 * CR-5: Resolve a per-request model id using the canonical fallback
 * (`model` → `modelId` → `response.model` → `result.model`). Shared by the
 * raw-requests loop and `normalizeChatRequest`.
 */
function resolveRequestModel(source: Record<string, unknown>): string | null {
  return (source.model ||
    source.modelId ||
    get(source.response, "model") ||
    get(source.result, "model") ||
    null) as string | null;
}

function hasRenderableContent(value: unknown, depth = 0): boolean {
  if (value == null || depth > 4) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasRenderableContent(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      hasRenderableContent(entry, depth + 1)
    );
  }
  return false;
}

function collectToolCalls(
  value: unknown,
  depth = 0,
  out: unknown[] = []
): unknown[] {
  if (value == null || depth > 4) {
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectToolCalls(entry, depth + 1, out);
    }
    return out;
  }
  if (typeof value !== "object") {
    return out;
  }

  const obj = value as Record<string, unknown>;
  for (const key of ["toolCalls", "tool_calls", "functionCalls"]) {
    const calls = obj[key];
    if (Array.isArray(calls)) {
      for (const call of calls) {
        out.push(call);
      }
    }
  }

  for (const key of [
    "message",
    "request",
    "prompt",
    "input",
    "response",
    "result",
    "reply",
    "output",
  ]) {
    collectToolCalls(obj[key], depth + 1, out);
  }
  return out;
}

type ChatEntry = {
  role: "user" | "assistant";
  timestamp: unknown;
  toolCalls?: unknown[];
  /** CR-1: User prompt or assistant response text. */
  text?: string | null;
  thinking?: boolean;
  error?: string | null;
  /** CR-5: Per-request model identifier. */
  model?: string | null;
  /** CR-2: Raw usage object for building tokenSeries. */
  usage?: Record<string, unknown> | null;
  /** CR-3: Tool result content keyed by tool call index/name. */
  toolResults?: Array<{ name: string; content: unknown; isError?: boolean }>;
};

/** CR-1: Best-effort extraction of displayable text from a Copilot message payload. */
function extractText(payload: unknown): string | null {
  if (payload == null) {
    return null;
  }
  if (typeof payload === "string") {
    return payload;
  }
  if (typeof payload !== "object") {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  // Direct text/content fields
  for (const key of [
    "text",
    "content",
    "markdown",
    "body",
    "value",
    "message",
  ]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) {
      return v;
    }
  }
  // Array of content parts (OpenAI-style)
  if (Array.isArray(obj.content)) {
    const parts = obj.content
      .map((p: unknown) => {
        if (typeof p === "string") {
          return p;
        }
        if (p && typeof p === "object") {
          const po = p as Record<string, unknown>;
          if (typeof po.text === "string") {
            return po.text;
          }
          if (typeof po.content === "string") {
            return po.content;
          }
        }
        return null;
      })
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return null;
}

/** CR-3: Collect tool result entries from a request's response flow. */
function collectToolResults(
  req: Record<string, unknown>
): Array<{ name: string; content: unknown; isError?: boolean }> {
  const results: Array<{ name: string; content: unknown; isError?: boolean }> =
    [];
  // Look in response.toolResults, result.toolResults, etc.
  for (const outer of ["response", "result", "reply", "output"]) {
    const container = req[outer];
    if (!container || typeof container !== "object") {
      continue;
    }
    const containerObj = container as Record<string, unknown>;
    for (const key of ["toolResults", "tool_results", "functionResults"]) {
      const arr = containerObj[key];
      if (!Array.isArray(arr)) {
        continue;
      }
      for (const entry of arr) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const e = entry as Record<string, unknown>;
        results.push({
          name: String(e.name || e.toolName || e.tool || "copilot_tool"),
          content: e.content ?? e.result ?? e.output ?? null,
          isError: Boolean(e.isError || e.is_error || e.error),
        });
      }
    }
  }
  return results;
}

function normalizeChatRequest(
  request: unknown,
  sessionData: Record<string, unknown>
): ChatEntry[] {
  if (!request || typeof request !== "object") {
    return [];
  }
  const req = request as Record<string, unknown>;

  const requestTimestamp =
    req.timestamp ||
    req.created_at ||
    req.createdAt ||
    req.requestDate ||
    get(req.message, "timestamp") ||
    get(req.message, "createdAt") ||
    sessionData.creationDate ||
    null;
  const responseTimestamp =
    req.responseTimestamp ||
    req.responseDate ||
    req.updatedAt ||
    get(req.response, "timestamp") ||
    get(req.result, "timestamp") ||
    sessionData.lastMessageDate ||
    requestTimestamp;
  const userPayload = req.message ?? req.request ?? req.prompt ?? req.input;
  const assistantPayload =
    req.response ?? req.result ?? req.reply ?? req.output;
  const toolCalls = collectToolCalls(req);
  const assistantError = extractErrorMessage(
    req.responseError ??
      req.error ??
      get(req.result, "error") ??
      get(req.response, "error")
  );

  // CR-1: Extract user and assistant text
  const userText = extractText(userPayload);
  const assistantText = extractText(assistantPayload);

  // CR-5: Per-request model
  const reqModel = resolveRequestModel(req);

  // CR-2: Per-request usage for tokenSeries
  const usageObj = resolveUsageObject(req);

  // CR-3: Tool results from the response flow
  const toolResults = collectToolResults(req);

  const entries: ChatEntry[] = [];
  if (
    hasRenderableContent(userPayload) ||
    req.id != null ||
    req.requestId != null
  ) {
    entries.push({
      role: "user",
      timestamp: requestTimestamp,
      text: truncateText(userText),
      model: reqModel,
    });
  }

  if (
    hasRenderableContent(assistantPayload) ||
    assistantError != null ||
    toolCalls.length > 0 ||
    req.response != null ||
    req.result != null ||
    req.reply != null ||
    req.output != null
  ) {
    const isThinking = Boolean(
      req.thinking ||
        req.reasoning ||
        get(req.response, "thinking") ||
        get(req.response, "reasoning") ||
        get(req.result, "thinking") ||
        get(req.result, "reasoning")
    );
    entries.push({
      role: "assistant",
      timestamp: responseTimestamp,
      toolCalls,
      text: isThinking ? null : truncateText(assistantText),
      thinking: isThinking,
      error: assistantError,
      model: reqModel,
      usage: usageObj,
      toolResults,
    });
  }

  return entries;
}

function normalizeChatMessages(data: Record<string, unknown>): unknown[] {
  for (const key of ["messages", "turns", "history"]) {
    const value = data[key];
    if (Array.isArray(value) && value.length > 0) {
      return value;
    }
  }

  const requests = Array.isArray(data.requests) ? data.requests : [];
  return requests.flatMap((request) => normalizeChatRequest(request, data));
}

type TokenFields = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

// Canonical fresh shape (see NormalizedTokenCounts): Copilot reports `input`
// as FRESH/uncached with cache_read/cache_write as separate additive fields
// (confirmed by fixtures where cache_read far exceeds input — impossible under
// an inclusive total), so they are read verbatim — no subtraction.
function readCopilotUsage(
  usage: Record<string, unknown>,
  context: string
): TokenFields {
  const input = readStorageTokenCountAlias(usage, `${context}.input`, [
    "input_tokens",
    "prompt_tokens",
  ]);
  const output = addStorageTokenCounts(
    readStorageTokenCountAlias(usage, `${context}.output`, [
      "output_tokens",
      "completion_tokens",
    ]),
    readStorageTokenCountAlias(usage, `${context}.reasoning`, [
      "reasoning_tokens",
      "reasoning_output_tokens",
    ]),
    `${context}.output_with_reasoning`
  );
  const cacheRead = readStorageTokenCountAlias(usage, `${context}.cache_read`, [
    "cache_read_tokens",
    "cached_input_tokens",
  ]);
  const cacheWrite = readStorageTokenCountAlias(
    usage,
    `${context}.cache_write`,
    ["cache_write_tokens", "cache_creation_input_tokens"]
  );
  return { input, output, cacheRead, cacheWrite };
}

function addTokenFields(
  target: TokenFields,
  next: TokenFields,
  context: string
): void {
  target.input = addStorageTokenCounts(
    target.input,
    next.input,
    `${context}.input`
  );
  target.output = addStorageTokenCounts(
    target.output,
    next.output,
    `${context}.output`
  );
  target.cacheRead = addStorageTokenCounts(
    target.cacheRead,
    next.cacheRead,
    `${context}.cache_read`
  );
  target.cacheWrite = addStorageTokenCounts(
    target.cacheWrite,
    next.cacheWrite,
    `${context}.cache_write`
  );
}

function maxTokenFields(target: TokenFields, next: TokenFields): void {
  target.input = Math.max(target.input, next.input);
  target.output = Math.max(target.output, next.output);
  target.cacheRead = Math.max(target.cacheRead, next.cacheRead);
  target.cacheWrite = Math.max(target.cacheWrite, next.cacheWrite);
}

function hasTokenFields(tokens: TokenFields): boolean {
  return Boolean(
    tokens.input || tokens.output || tokens.cacheRead || tokens.cacheWrite
  );
}

/**
 * Mutable per-session accumulator shared by the chat-message role handlers and
 * the raw-request loop. Bundling the running state lets each handler be a small
 * named function instead of an inline branch in `parseChatSessionFile`.
 */
/**
 * Running state common to every per-session accumulator. Both the chat-loop
 * accumulator (`ChatAccumulator`) and the CLI-event accumulator
 * (`CliEventAccumulator`) extend this with their format-specific fields.
 */
type BaseSessionAccumulator = {
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  userMessageCount: number;
  assistantMessageCount: number;
  thinkingBlockCount: number;
  pendingTurnStartedAt: string | null;
  messageTimestamps: string[];
  toolUses: NormalizedToolUse[];
  turnDurations: NormalizedTurnDuration[];
  apiErrors: NormalizedApiError[];
  toolResultErrors: NormalizedSession["toolResultErrors"];
  tokenFields: TokenFields;
  normalizedMessages: NormalizedMessage[];
  tokenSeries: NormalizedTokenRecord[];
};

type ChatAccumulator = BaseSessionAccumulator & {
  /** Session-level model used as the tokenSeries fallback. */
  sessionModel: string | null;
};

/** Per-message context resolved once and passed to each handler. */
type ChatMessageContext = {
  msgObj: Record<string, unknown>;
  iso: string | null;
  msgModel: string | null;
  synthetic: true | undefined;
};

/** Handle a user/human chat message: count it and emit the human message. */
function handleUserChatMessage(
  acc: ChatAccumulator,
  { msgObj, iso, msgModel, synthetic }: ChatMessageContext
): void {
  acc.userMessageCount++;
  if (iso) {
    acc.pendingTurnStartedAt = iso;
  }
  acc.normalizedMessages.push({
    role: "human",
    timestamp: iso,
    text: truncateText((msgObj.text as string | null) ?? extractText(msgObj)),
    model: msgModel,
    ...(synthetic ? { isSynthetic: true } : {}),
  });
}

/**
 * Handle an assistant/copilot/bot chat message: count it, close the open turn,
 * emit the assistant message, and feed per-message usage into tokenSeries.
 */
function handleAssistantChatMessage(
  acc: ChatAccumulator,
  { msgObj, iso, msgModel, synthetic }: ChatMessageContext
): void {
  acc.assistantMessageCount++;
  if (iso) {
    acc.messageTimestamps.push(iso);
  }
  pushTurnDuration(acc.turnDurations, acc.pendingTurnStartedAt, iso);
  acc.pendingTurnStartedAt = null;

  const isThinking = Boolean(msgObj.thinking || msgObj.reasoning);
  // CR-1: Assistant message (thinking indicator uses null text)
  acc.normalizedMessages.push({
    role: "assistant",
    timestamp: iso,
    text: isThinking
      ? null
      : truncateText((msgObj.text as string | null) ?? extractText(msgObj)),
    model: msgModel,
    ...(isThinking ? { isThinking: true } : {}),
    ...(synthetic ? { isSynthetic: true } : {}),
  });

  // CR-2: Build tokenSeries from per-message usage
  const msgUsage = msgObj.usage as Record<string, unknown> | null | undefined;
  if (msgUsage && typeof msgUsage === "object" && iso) {
    const tokens = readCopilotUsage(msgUsage, "copilot.message");
    if (hasTokenFields(tokens)) {
      acc.tokenSeries.push({
        timestamp: iso,
        model: msgModel || acc.sessionModel || "copilot-default",
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
      });
    }
  }
}

/** Role → handler map for the chat-message loop (aliases share a handler). */
const CHAT_ROLE_HANDLERS = new Map<
  string,
  (acc: ChatAccumulator, ctx: ChatMessageContext) => void
>([
  ["user", handleUserChatMessage],
  ["human", handleUserChatMessage],
  ["assistant", handleAssistantChatMessage],
  ["copilot", handleAssistantChatMessage],
  ["bot", handleAssistantChatMessage],
]);

/** Collect tool calls embedded in a message into the accumulator. */
function accumulateChatToolCalls(
  acc: ChatAccumulator,
  { msgObj, iso }: ChatMessageContext
): void {
  const calls =
    msgObj.toolCalls ||
    msgObj.tool_calls ||
    msgObj.functionCalls ||
    collectToolCalls(msgObj);
  if (!Array.isArray(calls)) {
    return;
  }
  for (const call of calls) {
    if (!call) {
      continue;
    }
    const callObj = call as Record<string, unknown>;
    // CR-3: Capture tool result content from call-level result
    const rawOutput =
      callObj.result ?? callObj.output ?? callObj.response ?? null;
    const outputText =
      typeof rawOutput === "string" ? truncateText(rawOutput) : rawOutput;
    const callIsError = Boolean(callObj.isError || callObj.is_error);
    acc.toolUses.push({
      name: String(
        callObj.name || get(callObj.function, "name") || "copilot_tool"
      ),
      timestamp: iso || acc.firstTimestamp,
      input: safeJson(callObj.arguments || callObj.input || callObj.parameters),
      ...(outputText == null ? {} : { output: outputText }),
      ...(callIsError ? { isError: true } : {}),
    });
  }
}

/**
 * CR-3: Back-link tool results from the ChatEntry enrichment path onto the most
 * recent matching tool use that is still missing output.
 */
function accumulateChatToolResults(
  acc: ChatAccumulator,
  { msgObj }: ChatMessageContext
): void {
  const toolResults = msgObj.toolResults;
  if (!Array.isArray(toolResults)) {
    return;
  }
  for (const tr of toolResults) {
    if (!tr || typeof tr !== "object") {
      continue;
    }
    const trObj = tr as Record<string, unknown>;
    const rawContent = trObj.content ?? trObj.result ?? trObj.output ?? null;
    const contentText =
      typeof rawContent === "string" ? truncateText(rawContent) : rawContent;
    // Try to match to the last tool use with the same name
    const trName = String(trObj.name || "copilot_tool");
    const matchIdx = acc.toolUses.findLastIndex(
      (tu) => tu.name === trName && tu.output == null
    );
    if (matchIdx >= 0) {
      if (contentText != null) {
        acc.toolUses[matchIdx].output = contentText;
      }
      if (trObj.isError || trObj.is_error) {
        acc.toolUses[matchIdx].isError = true;
      }
    }
  }
}

/** Count thinking blocks and capture any error message on a message. */
function accumulateChatThinkingAndErrors(
  acc: ChatAccumulator,
  { msgObj, iso }: ChatMessageContext
): void {
  if (msgObj.thinking || msgObj.reasoning) {
    acc.thinkingBlockCount++;
  }
  const errorMessage = extractErrorMessage(msgObj.error);
  if (errorMessage) {
    acc.apiErrors.push({
      type: "error",
      message: errorMessage,
      timestamp: iso,
    });
  }
}

/** Fold a message's embedded usage into the session token totals. */
function accumulateChatEmbeddedUsage(
  acc: ChatAccumulator,
  { msgObj }: ChatMessageContext
): void {
  const usageObj = resolveUsageObject(msgObj);
  if (usageObj) {
    addTokenFields(
      acc.tokenFields,
      readCopilotUsage(usageObj, "copilot.embedded_usage"),
      "copilot.embedded_usage_sum"
    );
  }
}

/**
 * CR-2: Build an extra tokenSeries entry from a raw request whose richer usage
 * was not already captured at the same timestamp by the message loop.
 */
function accumulateRequestTokenSeries(
  acc: ChatAccumulator,
  reqObj: Record<string, unknown>,
  dataObj: Record<string, unknown>
): void {
  const usageObj = resolveUsageObject(reqObj);
  if (!usageObj) {
    return;
  }
  const reqTs = toIso(
    reqObj.responseTimestamp ||
      reqObj.responseDate ||
      reqObj.updatedAt ||
      get(reqObj.response, "timestamp") ||
      get(reqObj.result, "timestamp") ||
      reqObj.timestamp ||
      reqObj.created_at ||
      reqObj.createdAt ||
      dataObj.lastMessageDate ||
      null
  );
  if (!reqTs) {
    return;
  }
  // Skip if we already have a tokenSeries entry at this exact timestamp
  if (acc.tokenSeries.some((ts) => ts.timestamp === reqTs)) {
    return;
  }
  const reqModel = resolveRequestModel(reqObj);
  const tokens = readCopilotUsage(usageObj, "copilot.request_usage");
  if (hasTokenFields(tokens)) {
    acc.tokenSeries.push({
      timestamp: reqTs,
      model: reqModel || acc.sessionModel || "copilot-default",
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
    });
  }
}

// FEA-3132 (B5): cap the chat file size we buffer. `parseChatSessionFile` does
// JSON.parse(readFileSync(file)) — the whole file into the db-host heap at once,
// with no size check. VS Code chat files are small; a runaway file would OOM the
// worker on the cold parse. Skip oversized files (64 MiB is far above any real
// chat session) rather than buffer them.
const MAX_CHAT_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Parse a Copilot Chat JSON session file (VS Code extension).
 * Recent VS Code builds persist these as top-level metadata plus `requests[]`,
 * while older shapes may store direct `messages[]` / `turns[]` arrays.
 */
export function parseChatSessionFile(
  filePath: string,
  workspacePath: string | null
): NormalizedSession | null {
  let data: unknown;
  try {
    if (fs.statSync(filePath).size > MAX_CHAT_FILE_BYTES) {
      return null;
    }
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }

  if (!data || typeof data !== "object") {
    return null;
  }
  const dataObj = data as Record<string, unknown>;

  const sessionId = String(
    dataObj.sessionId || dataObj.id || path.basename(filePath, ".json")
  );

  const rawRequests = Array.isArray(dataObj.requests) ? dataObj.requests : [];

  const messages = normalizeChatMessages(dataObj);
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  // Session-level model — extracted early so tokenSeries fallback can reference it
  const model = (dataObj.model || dataObj.modelId || null) as string | null;

  const acc: ChatAccumulator = {
    firstTimestamp: null,
    lastTimestamp: null,
    userMessageCount: 0,
    assistantMessageCount: 0,
    thinkingBlockCount: 0,
    pendingTurnStartedAt: null,
    messageTimestamps: [],
    toolUses: [],
    turnDurations: [],
    apiErrors: [],
    toolResultErrors: [],
    tokenFields: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    normalizedMessages: [],
    tokenSeries: [],
    sessionModel: model,
  };

  const noteTs = (raw: unknown): string | null => noteTimestamp(acc, raw);

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const msgObj = msg as Record<string, unknown>;
    const ts =
      msgObj.timestamp ||
      msgObj.created_at ||
      msgObj.createdAt ||
      msgObj.date ||
      null;
    const iso = noteTs(ts);
    const role = msgObj.role || msgObj.author || msgObj.type || "";

    // CR-5: Per-message model
    const msgModel = (msgObj.model as string | null) || null;
    const resolvedModel = msgModel || model || "copilot-default";
    const synthetic = isSyntheticModelKey(resolvedModel) ? true : undefined;
    const ctx: ChatMessageContext = { msgObj, iso, msgModel, synthetic };

    // Dispatch on role (user/human vs assistant/copilot/bot); unknown roles
    // still flow through the shared sub-handlers below.
    const handler =
      typeof role === "string" ? CHAT_ROLE_HANDLERS.get(role) : undefined;
    handler?.(acc, ctx);

    accumulateChatToolCalls(acc, ctx);
    accumulateChatToolResults(acc, ctx);
    accumulateChatThinkingAndErrors(acc, ctx);
    accumulateChatEmbeddedUsage(acc, ctx);
  }

  // CR-2: Also build tokenSeries from raw requests (for requests that go through
  // the normalizeChatRequest path which enriches ChatEntry with usage).
  // The normalizeChatMessages path already feeds into the message loop above,
  // but raw requests have richer usage data. Build additional series entries
  // from raw requests that weren't already captured.
  for (const req of rawRequests) {
    if (!req || typeof req !== "object") {
      continue;
    }
    accumulateRequestTokenSeries(acc, req as Record<string, unknown>, dataObj);
  }

  // Token usage from top-level session data
  const topUsage =
    dataObj.usage || dataObj.tokenUsage || dataObj.token_count || null;
  if (topUsage && typeof topUsage === "object") {
    const u = topUsage as Record<string, unknown>;
    maxTokenFields(acc.tokenFields, readCopilotUsage(u, "copilot.top_usage"));
  }

  if (!acc.firstTimestamp) {
    // Fall back to file mtime
    try {
      const stat = fs.statSync(filePath);
      acc.firstTimestamp =
        stat.birthtime?.toISOString() || stat.mtime.toISOString();
      acc.lastTimestamp = stat.mtime.toISOString();
    } catch {
      return null;
    }
  }

  const cwd = (workspacePath ||
    dataObj.cwd ||
    dataObj.workspaceFolder ||
    null) as string | null;

  let fileModifiedAt: number | null = null;
  try {
    fileModifiedAt = fs.statSync(filePath).mtimeMs;
  } catch {
    /* non-fatal */
  }

  const projectName = cwd
    ? path.basename(cwd)
    : `Copilot Chat ${sessionId.slice(0, 8)}`;

  const tokensByModel: NormalizedSession["tokensByModel"] = {};
  if (hasTokenFields(acc.tokenFields)) {
    const key = model || "copilot-default";
    tokensByModel[key] = {
      input: acc.tokenFields.input,
      output: acc.tokenFields.output,
      cacheRead: acc.tokenFields.cacheRead,
      cacheWrite: acc.tokenFields.cacheWrite,
    };
  }

  // Unset fields are filled by createNormalizedSession's defaults.
  return createNormalizedSession({
    sessionId: `copilot-chat-${sessionId}`,
    name: projectName,
    cwd,
    model,
    startedAt: acc.firstTimestamp,
    endedAt: acc.lastTimestamp,
    userMessages: acc.userMessageCount,
    assistantMessages: acc.assistantMessageCount,
    tokensByModel,
    messageTimestamps: acc.messageTimestamps,
    toolUses: acc.toolUses,
    apiErrors: acc.apiErrors,
    fileModifiedAt,
    turnDurations: acc.turnDurations,
    entrypoint: "copilot",
    thinkingBlockCount: acc.thinkingBlockCount,
    toolResultErrors: acc.toolResultErrors,
    // CR-1: Ordered messages with text content
    messages: acc.normalizedMessages,
    // CR-2: Per-turn token records
    tokenSeries: acc.tokenSeries,
    // CR-13: Artifact references extracted from tool calls
    artifacts: collectArtifacts(acc.toolUses, cwd),
  });
}

/**
 * FEA-3132 (B5): concurrency-capped wrapper around `parseChatSessionFile`.
 *
 * `parseChatSessionFile` buffers and `JSON.parse`s a whole chat file (its cold
 * full-file read). The `statSync` gate inside it bounds any single file, but N
 * concurrent parses of near-cap files still co-peak in the one db-host heap.
 * Routing the parse through the shared `coldReadGate` bounds that fan-out to
 * `COLD_READ_MAX_CONCURRENCY` (default 2) — so concurrent cold reads can't
 * stack — while leaving the synchronous parse itself unchanged.
 */
export function parseChatSessionFileGated(
  filePath: string,
  workspacePath: string | null
): Promise<NormalizedSession | null> {
  return coldReadGate.run(() => parseChatSessionFile(filePath, workspacePath));
}

/**
 * Mutable per-session accumulator shared by the Copilot CLI event handlers.
 * Mirrors the chat-loop accumulator pattern: bundling the running state lets each
 * event handler be a small named function instead of an inline `if (type === …)`
 * branch in `parseCliEventFile`.
 */
type CliEventAccumulator = BaseSessionAccumulator & {
  cwd: string | null;
  model: string | null;
  version: string | null;
};

/** Per-event context resolved once and passed to each CLI event handler. */
type CliEventContext = {
  type: string;
  payload: Record<string, unknown>;
  iso: string | null;
  /** CR-5: Per-event model override (`payload.model ?? rec.model`), null if absent. */
  eventModel: string | null;
  /** Synthetic-model flag for the resolved per-event model. */
  synthetic: true | undefined;
};

/** Capture session metadata (cwd/version/model) from a session-start event. */
function handleCliSessionMeta(
  acc: CliEventAccumulator,
  { payload }: CliEventContext
): void {
  if (!acc.cwd) {
    acc.cwd = (payload.cwd || payload.workdir || null) as string | null;
  }
  if (!acc.version) {
    acc.version = (payload.version || payload.cli_version || null) as
      | string
      | null;
  }
  if (!acc.model) {
    acc.model = (payload.model || null) as string | null;
  }
}

/** Handle a user/prompt event: count it, open a turn, emit the human message. */
function handleCliUserMessage(
  acc: CliEventAccumulator,
  { payload, iso, eventModel, synthetic }: CliEventContext
): void {
  acc.userMessageCount++;
  if (iso) {
    acc.pendingTurnStartedAt = iso;
  }
  // CR-1: User message with text content
  const userText = extractText(
    payload.content ??
      payload.message ??
      payload.text ??
      payload.prompt ??
      payload
  );
  acc.normalizedMessages.push({
    role: "human",
    timestamp: iso,
    text: truncateText(userText),
    model: eventModel,
    ...(synthetic ? { isSynthetic: true } : {}),
  });
}

/** Handle an assistant/response event: count it, close the turn, emit the message. */
function handleCliAssistantMessage(
  acc: CliEventAccumulator,
  { payload, iso, eventModel, synthetic }: CliEventContext
): void {
  acc.assistantMessageCount++;
  if (iso) {
    acc.messageTimestamps.push(iso);
  }
  pushTurnDuration(acc.turnDurations, acc.pendingTurnStartedAt, iso);
  acc.pendingTurnStartedAt = null;
  // CR-1: Assistant message with text content
  const assistantText = extractText(
    payload.content ??
      payload.message ??
      payload.text ??
      payload.response ??
      payload
  );
  acc.normalizedMessages.push({
    role: "assistant",
    timestamp: iso,
    text: truncateText(assistantText),
    model: eventModel,
    ...(synthetic ? { isSynthetic: true } : {}),
  });
}

/** Handle a tool/function/command call event. */
function handleCliToolCall(
  acc: CliEventAccumulator,
  { payload, iso }: CliEventContext
): void {
  acc.toolUses.push({
    name: String(
      payload.name || payload.tool || payload.command || "copilot_tool"
    ),
    timestamp: iso || acc.firstTimestamp,
    input: safeJson(payload.arguments || payload.input),
  });
}

/**
 * CR-3: Back-link a tool result to the most recent matching tool use that is
 * still missing output.
 */
function handleCliToolResult(
  acc: CliEventAccumulator,
  { payload }: CliEventContext
): void {
  const resultName = String(payload.name || payload.tool || "copilot_tool");
  const rawContent =
    payload.content ?? payload.result ?? payload.output ?? null;
  const contentText =
    typeof rawContent === "string" ? truncateText(rawContent) : rawContent;
  const resultIsError = Boolean(
    payload.isError || payload.is_error || payload.error
  );
  const matchIdx = acc.toolUses.findLastIndex(
    (tu) => tu.name === resultName && tu.output == null
  );
  if (matchIdx >= 0) {
    if (contentText != null) {
      acc.toolUses[matchIdx].output = contentText;
    }
    if (resultIsError) {
      acc.toolUses[matchIdx].isError = true;
    }
  }
}

/**
 * Handle a usage/token_count/metrics event: replace the running token totals
 * (last event wins) and append a tokenSeries point.
 */
function handleCliUsage(
  acc: CliEventAccumulator,
  { payload, iso, eventModel }: CliEventContext
): void {
  const info = (payload.usage || payload) as Record<string, unknown>;
  const tokens = readCopilotUsage(info, "copilot.cli_usage");
  acc.tokenFields.input = tokens.input;
  acc.tokenFields.output = tokens.output;
  acc.tokenFields.cacheRead = tokens.cacheRead;
  acc.tokenFields.cacheWrite = tokens.cacheWrite;
  if (payload.model) {
    acc.model = payload.model as string;
  }

  // CR-2: Push per-event token record for time-series
  if (iso) {
    const usageModel = eventModel || acc.model || "copilot-default";
    if (hasTokenFields(tokens)) {
      acc.tokenSeries.push({
        timestamp: iso,
        model: usageModel,
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
      });
    }
  }
}

/** Handle an error/api_error event. */
function handleCliError(
  acc: CliEventAccumulator,
  { type, payload, iso }: CliEventContext
): void {
  acc.apiErrors.push({
    type: String(type),
    message: String(payload.message || payload.error || "Copilot CLI error"),
    timestamp: iso,
  });
}

/**
 * Handle a reasoning/thinking event. Copilot provides a boolean-only thinking
 * flag, so emit a thinking indicator message with null text.
 */
function handleCliReasoning(
  acc: CliEventAccumulator,
  { iso, eventModel, synthetic }: CliEventContext
): void {
  acc.thinkingBlockCount++;
  // CR-1: Thinking indicator as message with null text
  acc.normalizedMessages.push({
    role: "assistant",
    timestamp: iso,
    text: null,
    model: eventModel,
    isThinking: true,
    ...(synthetic ? { isSynthetic: true } : {}),
  });
}

/** Event-type alias → handler for the CLI event loop (aliases share a handler). */
const CLI_EVENT_HANDLERS = new Map<
  string,
  (acc: CliEventAccumulator, ctx: CliEventContext) => void
>([
  ["session_start", handleCliSessionMeta],
  ["session_created", handleCliSessionMeta],
  ["init", handleCliSessionMeta],
  ["user_message", handleCliUserMessage],
  ["user_input", handleCliUserMessage],
  ["prompt", handleCliUserMessage],
  ["assistant_message", handleCliAssistantMessage],
  ["response", handleCliAssistantMessage],
  ["completion", handleCliAssistantMessage],
  ["tool_call", handleCliToolCall],
  ["function_call", handleCliToolCall],
  ["command", handleCliToolCall],
  ["tool_result", handleCliToolResult],
  ["function_result", handleCliToolResult],
  ["command_result", handleCliToolResult],
  ["usage", handleCliUsage],
  ["token_count", handleCliUsage],
  ["metrics", handleCliUsage],
  ["error", handleCliError],
  ["api_error", handleCliError],
  ["reasoning", handleCliReasoning],
  ["thinking", handleCliReasoning],
]);

/**
 * Parse a Copilot CLI events.jsonl file. Each line is dispatched through
 * `CLI_EVENT_HANDLERS` (event-type alias → handler over a shared accumulator),
 * replacing the former flat `if (type === a || b || c)` cascade.
 */
export async function parseCliEventFile(
  filePath: string,
  sessionId: string
): Promise<NormalizedSession | null> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  const acc: CliEventAccumulator = {
    cwd: null,
    model: null,
    version: null,
    firstTimestamp: null,
    lastTimestamp: null,
    userMessageCount: 0,
    assistantMessageCount: 0,
    thinkingBlockCount: 0,
    pendingTurnStartedAt: null,
    messageTimestamps: [],
    toolUses: [],
    turnDurations: [],
    apiErrors: [],
    toolResultErrors: [],
    tokenFields: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // CR-1: Ordered messages with text content
    normalizedMessages: [],
    // CR-2: Per-turn token records for time-series
    tokenSeries: [],
  };

  const noteTs = (raw: unknown): string | null => noteTimestamp(acc, raw);

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") {
      continue;
    }
    const recObj = rec as Record<string, unknown>;

    const ts = recObj.timestamp || recObj.ts || recObj.created_at || null;
    const iso = noteTs(ts);
    const type = String(recObj.type || recObj.event || "");
    const payload = (recObj.payload || recObj.data || recObj) as Record<
      string,
      unknown
    >;

    const handler = CLI_EVENT_HANDLERS.get(type);
    if (!handler) {
      continue;
    }

    // CR-5: Per-event model, resolved once for the message/usage/reasoning
    // handlers. Session metadata is applied via handleCliSessionMeta, which is
    // mutually exclusive with the model-consuming event types.
    const eventModel = (payload.model || recObj.model || null) as string | null;
    const cliResolvedModel = eventModel || acc.model || "copilot-default";
    const synthetic = isSyntheticModelKey(cliResolvedModel) ? true : undefined;

    handler(acc, { type, payload, iso, eventModel, synthetic });
  }

  if (!acc.firstTimestamp) {
    return null;
  }

  const tokensByModel: NormalizedSession["tokensByModel"] = {};
  if (hasTokenFields(acc.tokenFields)) {
    const key = acc.model || "copilot-default";
    tokensByModel[key] = {
      input: acc.tokenFields.input,
      output: acc.tokenFields.output,
      cacheRead: acc.tokenFields.cacheRead,
      cacheWrite: acc.tokenFields.cacheWrite,
    };
  }

  let fileModifiedAt: number | null = null;
  try {
    fileModifiedAt = fs.statSync(filePath).mtimeMs;
  } catch {
    /* non-fatal */
  }

  const projectName = acc.cwd
    ? path.basename(acc.cwd)
    : `Copilot CLI ${sessionId.slice(0, 8)}`;

  // Unset fields are filled by createNormalizedSession's defaults.
  return createNormalizedSession({
    sessionId: `copilot-cli-${sessionId}`,
    name: projectName,
    cwd: acc.cwd,
    model: acc.model,
    version: acc.version,
    startedAt: acc.firstTimestamp,
    endedAt: acc.lastTimestamp,
    userMessages: acc.userMessageCount,
    assistantMessages: acc.assistantMessageCount,
    tokensByModel,
    messageTimestamps: acc.messageTimestamps,
    toolUses: acc.toolUses,
    apiErrors: acc.apiErrors,
    fileModifiedAt,
    turnDurations: acc.turnDurations,
    entrypoint: "copilot",
    thinkingBlockCount: acc.thinkingBlockCount,
    toolResultErrors: acc.toolResultErrors,
    // CR-1: Ordered messages with text content
    messages: acc.normalizedMessages,
    // CR-2: Per-turn token records
    tokenSeries: acc.tokenSeries,
    // CR-13: Artifact references extracted from tool calls
    artifacts: collectArtifacts(acc.toolUses, acc.cwd),
  });
}

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
import { isRecord } from "../../../shared/type-guards.js";
import {
  createParseQualityScan,
  readJsonlLinesWithQuality,
} from "../engine/parse-quality-scan.js";
import {
  fileCreatedAtFromStats,
  stampFileCreatedAt,
} from "../file-created-at.js";
import { coldReadGate } from "../parsing/cold-read-gate.js";
import {
  collectArtifacts,
  extractErrorMessage,
  isMeaningfulCwd,
  isSyntheticModelKey,
  noteTimestamp,
  pushTurnDuration,
  safeJson,
  toIso,
  truncateText,
} from "../parsing/parser-utils.js";
import type { NormalizedSession } from "../types.js";
import { createNormalizedSession } from "../types.js";
import {
  CLI_EVENT_HANDLERS,
  type CliEventAccumulator,
} from "./copilot-cli-events.js";
import type { BaseSessionAccumulator } from "./copilot-session-accumulator.js";
import { extractText } from "./copilot-text.js";
import {
  addTokenFields,
  hasTokenFields,
  maxTokenFields,
  readCopilotUsage,
} from "./copilot-token-fields.js";

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

/**
 * Mutable per-session accumulator shared by the chat-message role handlers and
 * the raw-request loop. Bundling the running state lets each handler be a small
 * named function instead of an inline branch in `parseChatSessionFile`.
 */

type ChatAccumulator = BaseSessionAccumulator & {
  /** Session-level model used as the tokenSeries fallback. */
  sessionModel: string | null;
  /**
   * Timestamps already present in `tokenSeries`, mirrored at every push site so
   * the raw-request dedup is an O(1) `has` lookup instead of an O(n) scan.
   */
  seenTokenSeriesTimestamps: Set<string>;
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
      acc.seenTokenSeriesTimestamps.add(iso);
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
  if (acc.seenTokenSeriesTimestamps.has(reqTs)) {
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
    acc.seenTokenSeriesTimestamps.add(reqTs);
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
    seenTokenSeriesTimestamps: new Set(),
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
      // ISS-12251: an unusable (epoch-0) birth time falls back to mtime, not 1970.
      acc.firstTimestamp = new Date(
        fileCreatedAtFromStats(stat) ?? stat.mtimeMs
      ).toISOString();
      acc.lastTimestamp = stat.mtime.toISOString();
    } catch {
      return null;
    }
  }

  // FEA-3668: pick the first MEANINGFUL candidate (skip `/` and other non-repo
  // roots) rather than the first truthy one.
  const cwd =
    [
      workspacePath,
      typeof dataObj.cwd === "string" ? dataObj.cwd : null,
      typeof dataObj.workspaceFolder === "string"
        ? dataObj.workspaceFolder
        : null,
    ].find((candidate): candidate is string => isMeaningfulCwd(candidate)) ??
    null;

  let fileStats: fs.Stats | undefined;
  try {
    fileStats = fs.statSync(filePath);
  } catch {
    /* non-fatal */
  }

  const projectName = cwd
    ? path.basename(cwd)
    : `Copilot Chat ${sessionId.slice(0, 8)}`;

  // ISS-8565: null-prototype container so a key literally named `__proto__`
  // becomes an own property instead of hitting the inherited `__proto__`
  // setter, which creates no own key and silently drops the entry.
  const tokensByModel: NormalizedSession["tokensByModel"] = Object.create(null);
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
  const session = createNormalizedSession({
    sessionId: `copilot-chat-${sessionId}`,
    name: projectName,
    cwd,
    model,
    startedAt: acc.firstTimestamp,
    endedAt: acc.lastTimestamp,
    userMessages: acc.userMessageCount,
    assistantMessages: acc.assistantMessageCount,
    // ISS-8565: spread restores a normal prototype (spread defines, so an
    // own `__proto__` key survives the copy) for downstream consumers.
    tokensByModel: { ...tokensByModel },
    messageTimestamps: acc.messageTimestamps,
    toolUses: acc.toolUses,
    apiErrors: acc.apiErrors,
    fileModifiedAt: fileStats?.mtimeMs ?? null,
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
  stampFileCreatedAt(session, fileStats);
  return session;
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
 * Parse a Copilot CLI events.jsonl file. Each line is dispatched through
 * `CLI_EVENT_HANDLERS` (event-type alias → handler over a shared accumulator),
 * replacing the former flat `if (type === a || b || c)` cascade.
 */
export async function parseCliEventFile(
  filePath: string,
  sessionId: string
): Promise<NormalizedSession | null> {
  // ISS-6885: stream through the canonical parse-quality scanner (FEA-2905)
  // rather than a local `JSON.parse`-in-try/catch loop, so a corrupt line is
  // COUNTED instead of silently dropping its messages, tokens, tools, and
  // errors under totals that still read as complete.
  const scan = createParseQualityScan();
  // The scanner's counters cover only lines that failed `JSON.parse`. A record
  // that DECODED fine but the parser could not route is the second silent drop
  // channel, and gets the canonical `unknownRecords` bucket (FEA-3713).
  let unknownRecords = 0;

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

  for await (const { entry } of readJsonlLinesWithQuality(filePath, scan)) {
    // A line that parsed cleanly but decoded to a non-object (`null`, a number,
    // a bare string) is NOT malformed JSON, so it must not inflate that count —
    // but its content is still dropped, so it belongs in the unknown-record
    // bucket rather than in no bucket at all.
    if (!isRecord(entry)) {
      unknownRecords++;
      continue;
    }
    const recObj = entry;

    const ts = recObj.timestamp || recObj.ts || recObj.created_at || null;
    const iso = noteTs(ts);
    const type = String(recObj.type || recObj.event || "");
    const payload = (recObj.payload || recObj.data || recObj) as Record<
      string,
      unknown
    >;

    const handler = CLI_EVENT_HANDLERS.get(type);
    if (!handler) {
      // A record the alias table does not know is NOT inert: `noteTs` above has
      // already let it widen the session window, so the parser treats it as a
      // real event and then discards its messages, tokens, tools, and errors.
      // A newer Copilot CLI emitting a type this table predates would otherwise
      // import as a certified-clean parse with those facts missing.
      unknownRecords++;
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

  // ISS-8565: null-prototype container so a key literally named `__proto__`
  // becomes an own property instead of hitting the inherited `__proto__`
  // setter, which creates no own key and silently drops the entry.
  const tokensByModel: NormalizedSession["tokensByModel"] = Object.create(null);
  if (hasTokenFields(acc.tokenFields)) {
    const key = acc.model || "copilot-default";
    tokensByModel[key] = {
      input: acc.tokenFields.input,
      output: acc.tokenFields.output,
      cacheRead: acc.tokenFields.cacheRead,
      cacheWrite: acc.tokenFields.cacheWrite,
    };
  }

  let fileStats: fs.Stats | undefined;
  try {
    fileStats = fs.statSync(filePath);
  } catch {
    /* non-fatal */
  }

  const projectName = acc.cwd
    ? path.basename(acc.cwd)
    : `Copilot CLI ${sessionId.slice(0, 8)}`;

  // Unset fields are filled by createNormalizedSession's defaults.
  const session = createNormalizedSession({
    sessionId: `copilot-cli-${sessionId}`,
    name: projectName,
    cwd: acc.cwd,
    model: acc.model,
    version: acc.version,
    startedAt: acc.firstTimestamp,
    endedAt: acc.lastTimestamp,
    userMessages: acc.userMessageCount,
    assistantMessages: acc.assistantMessageCount,
    // ISS-8565: spread restores a normal prototype (spread defines, so an
    // own `__proto__` key survives the copy) for downstream consumers.
    tokensByModel: { ...tokensByModel },
    messageTimestamps: acc.messageTimestamps,
    toolUses: acc.toolUses,
    apiErrors: acc.apiErrors,
    fileModifiedAt: fileStats?.mtimeMs ?? null,
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
    // ISS-6885: report what this parse DISCARDED. Every count above is a
    // survivors-only tally, so without this a corrupt `events.jsonl` renders as
    // a complete session. `truncatedFinalLine` separates the benign shape — a
    // final line torn by a live, still-writing session — from mid-file
    // corruption, which consumers derive as
    // `malformedLines - (truncatedFinalLine ? 1 : 0)`.
    parseQuality: {
      totalLines: scan.totalLines,
      malformedLines: scan.malformedLines,
      truncatedFinalLine: scan.lastLineMalformed,
      // Emitted only when non-zero, matching the Codex parser: a clean session
      // omits the key so pre-existing metadata blobs round-trip byte-identically.
      ...(unknownRecords > 0 ? { unknownRecords } : {}),
    },
  });
  stampFileCreatedAt(session, fileStats);
  return session;
}

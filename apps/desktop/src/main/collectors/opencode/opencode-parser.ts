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
import { DatabaseSync } from "node:sqlite";
import { OpencodeDefaultModel } from "@repo/lib/harness/synthetic-model-keys";
import {
  addStorageTokenCounts,
  readStorageTokenCount,
} from "../../cost/token-counts.js";
import {
  collectArtifacts,
  computeUnifiedDiffDelta,
  countDiffFiles,
  extractErrorMessage,
  isMeaningfulCwd,
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
  type NormalizedMessage,
  type NormalizedSession,
  type NormalizedTokenCounts,
  type NormalizedTokenRecord,
  type NormalizedToolResultError,
  type NormalizedToolUse,
  type NormalizedTurnDuration,
} from "../types.js";
import { resolveOpencodeDiffStats } from "./opencode-diff-stats.js";
import { getOpenCodeDbPath } from "./opencode-home.js";
import {
  classifyOpencodeParseFailure,
  describeOpencodeParseFailure,
  type OpencodeDroppedSession,
  type OpencodeSessionLoad,
  opencodeParseFailureAbortsLoad,
  resolveSummaryColumnProbeFailure,
} from "./opencode-parse-failure.js";
import { extractOpenCodeTokenCounts } from "./opencode-token-extract.js";

type Row = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJsonCell(value: unknown): unknown {
  return typeof value === "string" ? safeJson(value) : value;
}

// Token-count extraction (including the nested OpenCode `tokens.cache` shape,
// ISS-4380) lives in `opencode-token-extract.ts` so this grandfathered parser
// stays smaller.
function extractTokenCounts(
  raw: Record<string, unknown>,
  context: string
): NormalizedTokenCounts | null {
  return extractOpenCodeTokenCounts(raw, context);
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
  // double-counting. Session-level token_usage normally derives from the
  // session-row aggregate; FEA-4183 additionally falls back to summing THIS
  // (already-deduped) series into `tokensByModel` when that aggregate is empty
  // (see buildTokensByModel), so keeping the series free of double-counts matters
  // for the session cost rollup too, not only token_events.
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
  // FEA-4183: require tokens + timestamp, but NOT a resolved model. A message
  // can carry real token counts with no model attribution (session model
  // unresolved and no per-message model); previously that dropped the usage
  // entirely, so the session showed zero tokens and no derivable cost. Fall
  // back to the synthetic `opencode-default` key — matching the step-token and
  // session-rollup paths in this parser — so the tokens are captured and the
  // cost engine's unknown-model fallback (FEA-3546) can price them.
  if (ctx.msgTokens && ctx.iso) {
    acc.tokenSeries.push({
      timestamp: ctx.iso,
      model: ctx.msgModel || OpencodeDefaultModel,
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
      OpencodeDefaultModel;
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
      const candidate = pathCwd || pathRoot || null;
      if (isMeaningfulCwd(candidate)) {
        acc.cwd = candidate;
      }
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

/**
 * FEA-4183: fall back to the accumulated per-message/step token series when the
 * session-row aggregate carried no usage. `importPhaseTokenUsage` writes the
 * `token_usage` rows (and thus the authoritative `sessions.cost_usd_estimated`
 * rollup, which `updateSessionCostRollup` derives EXCLUSIVELY from
 * `token_usage`) from `tokensByModel` — NOT from `tokenSeries`. So a session
 * whose only usage lives in message/step rows (zero session token columns)
 * would still record a null cost even though the series captured the tokens.
 * Summing the series under the single synthetic `opencode-default` key (matching
 * the series' own fallback attribution) gives that session a priceable
 * `token_usage` row so a non-zero cost derives. Marked `inferred` because the
 * key is a synthetic fallback, not a model id read from the store.
 */
function tokensByModelFromSeries(
  tokenSeries: readonly NormalizedTokenRecord[]
): Record<string, NormalizedTokenCounts> {
  const tokensByModel: Record<string, NormalizedTokenCounts> = {};
  if (tokenSeries.length === 0) {
    return tokensByModel;
  }
  const total: NormalizedTokenCounts = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    inferred: true,
  };
  for (const record of tokenSeries) {
    total.input += record.input;
    total.output += record.output;
    total.cacheRead += record.cacheRead;
    total.cacheWrite += record.cacheWrite;
  }
  if (total.input || total.output || total.cacheRead || total.cacheWrite) {
    tokensByModel[OpencodeDefaultModel] = total;
  }
  return tokensByModel;
}

/**
 * Build the per-model session-level token totals (5 token-column reads), falling
 * back to the accumulated token series when the session-row aggregate is empty
 * (see {@link tokensByModelFromSeries}).
 */
function buildTokensByModel(
  sessionRow: Row,
  sessionModel: string | null,
  tokenSeries: readonly NormalizedTokenRecord[]
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
    const key = sessionModel || agent || OpencodeDefaultModel;
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
    return tokensByModel;
  }
  return tokensByModelFromSeries(tokenSeries);
}

/**
 * The two per-session row reads a session parse performs, as plain functions so
 * the {@link OpencodeSessionLoadOptions.wrapRowReaders} seam can stand between
 * them and the prepared statements.
 */
export type OpencodeSessionRowReaders = {
  readMessages: (sessionId: SessionRowId) => Row[];
  readParts: (sessionId: SessionRowId) => Row[];
};

/** The `session.id` primary key as `node:sqlite` hands it back. */
type SessionRowId = string | number | bigint | null;

/**
 * Everything one session row's parse needs beyond the row itself: the two
 * per-session row reads, whether the optional `summary_*` columns exist, the
 * monitored diagnostic sink (ISS-5238), and the accumulator for sessions this
 * batch had to drop.
 */
type SessionParseContext = OpencodeSessionRowReaders & {
  hasSummaryCols: boolean;
  /** Reports a per-session degradation, already scoped to the source DB. */
  report: (sessionId: string, message: string) => void;
  /** Sessions dropped by a malformed row, in load order. */
  dropped: OpencodeDroppedSession[];
};

function parseSessionRow(
  sessionRow: Row,
  ctx: SessionParseContext
): NormalizedSession | null {
  const sessionId = sessionRow.id as SessionRowId;
  const messageRows = ctx.readMessages(sessionId);
  if (!Array.isArray(messageRows) || messageRows.length === 0) {
    return null;
  }

  const acc: SessionAccumulator = {
    sessionModel: modelIdFromValue(sessionRow.model),
    // FEA-3668: gate the PRIMARY seed too, not just the message-row override
    // below — an opencode `directory` of "/" would otherwise stick and never
    // reach the guarded fallback. (Row values are SQLOutputValue, so keep the
    // string narrowing before isMeaningfulCwd's string-only check.)
    cwd:
      typeof sessionRow.directory === "string" &&
      isMeaningfulCwd(sessionRow.directory)
        ? sessionRow.directory
        : null,
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
  processPartRows(acc, ctx.readParts(sessionId));

  if (!acc.firstTimestamp) {
    return null;
  }

  const tokensByModel = buildTokensByModel(
    sessionRow,
    acc.sessionModel,
    acc.tokenSeries
  );

  const sessionIdStr = String(sessionId);
  const diffStats = resolveOpencodeDiffStats(
    sessionRow,
    ctx.hasSummaryCols,
    {
      added: acc.totalAdded,
      removed: acc.totalRemoved,
      filesChanged: acc.totalFilesChanged,
    },
    (message) => ctx.report(sessionIdStr, message)
  );

  // CR-13: Collect artifact references from tool uses.
  const artifacts = collectArtifacts(acc.toolUses, acc.cwd);

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

/**
 * Parse one session row, isolating a MALFORMED row to that single session while
 * letting a STORE-level failure abort the batch.
 *
 * OpenCode reads the whole `opencode.db` as one batch, so an unhandled throw in
 * {@link parseSessionRow} — most plausibly an `InvalidTokenCountError` from a
 * corrupt/version-skewed token count in one message or step — would abort
 * {@link loadOpencodeSessionsFromDb} and drop EVERY valid session in the store.
 * Catching at the session boundary drops only the offending session and lets its
 * healthy siblings through.
 *
 * ISS-5238 (F1): but the catch used to be `catch { return null; }` — it swallowed
 * a transient `SQLITE_BUSY` past the 1s `busy_timeout` exactly as if the row were
 * bad. The batch then RESOLVED with a short list, so `markSourceImported`
 * advanced the DB fingerprint and `listSources` skipped the unchanged DB, and the
 * session that was merely unreadable for a moment stayed missing until the file's
 * mtime/size moved again. That is the same failed-read-frozen-as-fact defect
 * class as ISS-4649, and the engine is explicitly built to retry it
 * (`collector-manager-source-parse.ts:markSeenOnThrow` does not mark a batch
 * collector seen on a throw). So the two cases are now told apart explicitly by
 * {@link classifyOpencodeParseFailure}: a store failure RETHROWS (fingerprint
 * unadvanced, tick retried) and a malformed row is dropped, recorded on
 * `ctx.dropped`, and reported on the monitored channel by the caller.
 */
function parseSessionRowSafely(
  sessionRow: Row,
  ctx: SessionParseContext
): NormalizedSession | null {
  try {
    return parseSessionRow(sessionRow, ctx);
  } catch (error) {
    if (opencodeParseFailureAbortsLoad(classifyOpencodeParseFailure(error))) {
      throw error;
    }
    ctx.dropped.push({
      sessionId: String(sessionRow.id),
      reason: describeOpencodeParseFailure(error),
    });
    return null;
  }
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

/**
 * CR-9: Detect whether the session table has summary_* columns.
 *
 * ISS-5161: a FAILED `PRAGMA` is not a legacy schema — the same conflation
 * ISS-4649 split apart in {@link readSessionParentLinks}, on the same statement.
 * Returning `false` on a throw dropped `summary_*` from the SELECT, so
 * `resolveDiffStats` fell back to patch accumulation for EVERY session, the
 * parse resolved, and `markSourceImported` froze the understated corpus behind
 * the unchanged-DB gate. A genuinely legacy DB answers the PRAGMA successfully
 * and still reads as `false`, unchanged.
 *
 * ISS-5238 (wongk review) splits that refusal rather than throwing on every
 * failure: {@link resolveSummaryColumnProbeFailure} owns the split — a RETRYABLE
 * failure rethrows so the fingerprint stays put and the tick retries, while a
 * DURABLE one falls back to the legacy shape but SAYS SO on the monitored
 * channel, because propagating a failure that reproduces every tick would wedge
 * the whole corpus forever (a batch collector's throw is never marked seen).
 */
function hasSummaryColumns(
  db: DatabaseSync,
  report: (message: string) => void
): boolean {
  let cols: Row[];
  try {
    cols = db.prepare("PRAGMA table_info(session)").all() as Row[];
  } catch (error) {
    return resolveSummaryColumnProbeFailure(error, report);
  }
  const names = new Set(cols.map((c) => c.name));
  return (
    names.has("summary_additions") &&
    names.has("summary_deletions") &&
    names.has("summary_files") &&
    names.has("summary_diffs")
  );
}

/**
 * FEA-3932: one session's parent linkage read from the `session` table's
 * `parent_id` column. OpenCode nests subagent sessions under a parent session
 * via `parent_id`; the materializer uses this to file a subagent's projection
 * as `subagent:<childId>.jsonl` under the ROOT session's `externalSessionId`
 * instead of as its own top-level `main.jsonl`. `sessionId`/`parentId` are the
 * RAW opencode ids (NOT the `opencode-` prefixed `externalSessionId`).
 */
export type OpencodeSessionLink = {
  sessionId: string;
  parentId: string | null;
};

/**
 * ISS-4649 (finding 6): the three OUTCOMES of reading the parent linkage, which
 * a bare `[]` conflated.
 *
 * `Linked` — the `parent_id` column exists and its rows were read.
 * `Legacy` — no DB, or a DB predating the `parent_id` column: this install has
 *   no subagent concept at all, so every session legitimately stays top-level.
 * `Unreadable` — the read FAILED (a `SQLITE_BUSY` past the 1s busy timeout, a
 *   corrupt file, an open error). Emphatically NOT the same as `Legacy`: the DB
 *   may well have parents we simply could not see, so treating it as legacy
 *   un-nests every subagent for that import tick — and the collector's
 *   fingerprint gate then skips re-reading the unchanged DB, freezing the
 *   flattened result in place until the file's mtime/size changes again.
 */
export const OpencodeParentLinkReadStatus = {
  Linked: "linked",
  Legacy: "legacy",
  Unreadable: "unreadable",
} as const;
export type OpencodeParentLinkReadStatus =
  (typeof OpencodeParentLinkReadStatus)[keyof typeof OpencodeParentLinkReadStatus];

export type OpencodeParentLinkRead =
  | {
      status: typeof OpencodeParentLinkReadStatus.Linked;
      links: OpencodeSessionLink[];
    }
  | { status: typeof OpencodeParentLinkReadStatus.Legacy }
  | {
      status: typeof OpencodeParentLinkReadStatus.Unreadable;
      error: unknown;
    };

/**
 * Read the `(id, parent_id)` linkage for every session, reporting WHY it is
 * empty when it is. THE reader for every in-repo caller: the collector (which
 * must not import a flattened corpus off a transient lock) and the transcript
 * materializer (which must not re-root and then prune the correct subagent
 * projections). The legacy-shaped {@link loadSessionParentLinksFromDb} shim
 * below is retained only as the pre-ISS-4649 best-effort export.
 */
export function readSessionParentLinks(
  dbPath: string = getOpenCodeDbPath()
): OpencodeParentLinkRead {
  if (!(dbPath && fs.existsSync(dbPath))) {
    return { status: OpencodeParentLinkReadStatus.Legacy };
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch (error) {
    return { error, status: OpencodeParentLinkReadStatus.Unreadable };
  }
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    const cols = db.prepare("PRAGMA table_info(session)").all() as Row[];
    const hasParent = cols.some((c) => c.name === "parent_id");
    if (!hasParent) {
      return { status: OpencodeParentLinkReadStatus.Legacy };
    }
    const rows = db.prepare("SELECT id, parent_id FROM session").all() as Row[];
    const links: OpencodeSessionLink[] = [];
    for (const row of rows) {
      const id = row.id;
      if (id == null) {
        continue;
      }
      const parent = row.parent_id;
      links.push({
        sessionId: String(id),
        parentId: parent == null ? null : String(parent),
      });
    }
    return { links, status: OpencodeParentLinkReadStatus.Linked };
  } catch (error) {
    return { error, status: OpencodeParentLinkReadStatus.Unreadable };
  } finally {
    db.close();
  }
}

/**
 * Best-effort linkage read: a DB that predates the `parent_id` column, or that
 * could not be read at all, yields an empty map. Kept separate from
 * {@link loadSessionsFromDb} so the parser's `NormalizedSession` contract is
 * unchanged.
 *
 * ISS-4649: DO NOT reach for this in new code. It deliberately cannot tell a
 * legacy DB from a failed read, and every in-repo caller has moved to
 * {@link readSessionParentLinks} because that conflation is destructive on both
 * of them (the collector would import a flattened corpus and freeze it behind
 * its own fingerprint; the materializer would re-root every subagent, prune the
 * correct projections, and checkpoint past the damage). Retained as the
 * pre-ISS-4649 exported contract per the compatibility guardrail; the
 * `Unreadable`-flattens-to-`[]` behavior is pinned by
 * `test/opencode-subagent-fold.test.ts`.
 */
export function loadSessionParentLinksFromDb(
  dbPath: string = getOpenCodeDbPath()
): OpencodeSessionLink[] {
  const read = readSessionParentLinks(dbPath);
  return read.status === OpencodeParentLinkReadStatus.Linked ? read.links : [];
}

/**
 * ISS-5238: the loader's options. `log` is the MONITORED sink — the same
 * `collector <key> import failed: …` channel `defaultCollectors` threads into the
 * collector. The parser previously had no diagnostic sink at all, so every
 * degradation below it was completely silent, and the engine does not fill that
 * gap (`collector-manager-source-parse.ts` deliberately does not log a rejected
 * parse). Omitted = a no-op, as in tests and golden mode.
 */
export type OpencodeSessionLoadOptions = {
  log?: (message: string) => void;
  /**
   * The channel prefix every diagnostic from this load carries. Defaults to the
   * collector's monitored `collector opencode import failed` event; the
   * materializer passes its own so a transcript-sync degradation is not triaged
   * as a collector import failure.
   */
  logPrefix?: string;
  /**
   * Per-session row-reader seam (default: the DB's own prepared statements).
   *
   * Exists so the RETRYABLE-failure rethrow in {@link parseSessionRowSafely} is
   * reachable in a test, in the same spirit as ISS-4649's `readParentLinks`
   * seam. A real transient `SQLITE_BUSY` at the row boundary needs a write lock
   * to land BETWEEN the session SELECT and the per-session reads, which a
   * single-threaded test cannot schedule; a lock held for the whole load fails
   * the outer SELECT first and never reaches that branch. Wrapping the readers
   * lets a test raise a REAL captured `node:sqlite` error at exactly the seam
   * the production code guards.
   */
  wrapRowReaders?: (
    readers: OpencodeSessionRowReaders
  ) => OpencodeSessionRowReaders;
};

/** The monitored `CollectorManager` event the collector's own logger emits. */
const COLLECTOR_IMPORT_FAILED_PREFIX = "collector opencode import failed";

/**
 * Load every session from `opencode.db`, REPORTING what was dropped.
 *
 * Prefer this over {@link loadSessionsFromDb} in any caller that prunes,
 * deletes, checkpoints, or re-roots off the result: a short list is otherwise
 * indistinguishable from a store that legitimately holds fewer sessions, which
 * is what let the materializer delete a still-correct projection (ISS-5238 F3)
 * and the subagent fold re-flatten a dropped parent's children (F2).
 *
 * THROWS when SQLite itself could not serve the read — see
 * {@link parseSessionRowSafely}. A caller must let that propagate rather than
 * persist a partial corpus.
 */
export function loadOpencodeSessionsFromDb(
  dbPath: string = getOpenCodeDbPath(),
  options: OpencodeSessionLoadOptions = {}
): OpencodeSessionLoad {
  const log = options.log ?? (() => undefined);
  const prefix = options.logPrefix ?? COLLECTOR_IMPORT_FAILED_PREFIX;
  const load = readSessionsFromDb(dbPath, log, prefix, options.wrapRowReaders);
  for (const drop of load.droppedSessions) {
    log(
      `${prefix}: dropped session ${drop.sessionId} from ${dbPath} (${drop.reason}); the row could not be parsed, so it is omitted from this import`
    );
  }
  return load;
}

/**
 * Array form, retained as the historical export for the read-only callers
 * (golden corpus, fixtures, tests) that only want the sessions. It reports
 * nothing and, like {@link loadOpencodeSessionsFromDb}, THROWS on a retryable
 * store-level read failure — it is not a best-effort reader. New code that acts
 * on absence wants {@link loadOpencodeSessionsFromDb}.
 */
export function loadSessionsFromDb(
  dbPath: string = getOpenCodeDbPath()
): NormalizedSession[] {
  return loadOpencodeSessionsFromDb(dbPath).sessions;
}

function readSessionsFromDb(
  dbPath: string,
  log: (message: string) => void,
  prefix: string,
  wrapRowReaders?: (
    readers: OpencodeSessionRowReaders
  ) => OpencodeSessionRowReaders
): OpencodeSessionLoad {
  if (!(dbPath && fs.existsSync(dbPath))) {
    return { sessions: [], droppedSessions: [] };
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1000");

    // CR-9: Detect optional summary columns before building the SELECT.
    const hasSummaryCols = hasSummaryColumns(db, (message) =>
      log(`${prefix}: ${dbPath}: ${message}`)
    );

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

    const readers: OpencodeSessionRowReaders = {
      readMessages: (sessionId) => getMessages.all(sessionId) as Row[],
      readParts: (sessionId) => getParts.all(sessionId) as Row[],
    };
    const ctx: SessionParseContext = {
      ...(wrapRowReaders ? wrapRowReaders(readers) : readers),
      hasSummaryCols,
      dropped: [],
      // Surfaced where the context is richest: the session AND the store the
      // value came from, not an anonymous inner frame.
      report: (sessionId, message) =>
        log(`${prefix}: session ${sessionId} in ${dbPath}: ${message}`),
    };
    const out: NormalizedSession[] = [];
    for (const row of sessionRows) {
      // OpenCode is a BATCH harness — the whole `opencode.db` is parsed in one
      // load. A single malformed row must NOT suppress every valid session, so
      // isolate each session: a throw (e.g. `InvalidTokenCountError` from a
      // corrupt token count) drops only that session and the rest survive. A
      // STORE-level failure still propagates (ISS-5238 F1).
      const session = parseSessionRowSafely(row, ctx);
      if (session) {
        out.push(session);
      }
    }
    return { sessions: out, droppedSessions: ctx.dropped };
  } finally {
    db.close();
  }
}

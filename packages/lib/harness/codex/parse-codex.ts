/**
 * @file parse-codex.ts
 * @description Browser-safe OpenAI Codex CLI rollout parser core (extracted to
 * `@repo/lib/harness` for FEA-2717). Consumes an (async) iterable of rollout
 * JSONL lines — the desktop shell streams them from a file, the cloud renderer
 * splits the archived rollout — and produces the shared `NormalizedSession` so
 * Codex sessions render through the unchanged UI exactly like Claude sessions.
 *
 * Codex's rollout format has drifted across releases, so parsing is
 * intentionally tolerant: it accepts the modern RolloutLine envelope
 * (`{type:"session_meta"|"event_msg"|"response_item", payload, timestamp}`),
 * older bare records (the item itself on the line), and auto-detects a typed
 * `payload` under an unknown wrapper. Token usage in Codex `token_count`
 * events is CUMULATIVE per session, so the final value is the session total
 * (no delta math needed). Model attribution follows CodexBar's documented
 * rule: `turn_context.model` is authoritative.
 *
 * The desktop-only workflow-journal token merge, mtime read, session-id
 * derivation, and burst-threshold env reads stay in
 * `apps/desktop/.../codex-parser.ts`; the burst thresholds are injected here.
 *
 * Reference for the Codex format & token/model semantics: steipete/CodexBar
 * `docs/codex.md` (MIT) — see THIRD_PARTY_NOTICES.md.
 *
 * Ported from `scripts/agent-monitor-codex/codex-parser.js` (logic preserved).
 */

import {
  baseName,
  collectArtifacts,
  computeUnifiedDiffDelta,
  countDiffFiles,
  noteTimestamp as foldTimestampBounds,
  isSyntheticModelKey,
  pushTurnDuration,
  safeJson,
  truncateText,
} from "../parser-utils";
import {
  addStorageTokenCounts,
  readStorageTokenCountAlias,
  subtractStorageTokenCounts,
} from "../token-counts";
import { asRecord } from "../type-guards";
import type {
  NormalizedApiError,
  NormalizedArtifacts,
  NormalizedDiffStats,
  NormalizedMessage,
  NormalizedPlan,
  NormalizedSession,
  NormalizedTokenCounts,
  NormalizedTokenRecord,
  NormalizedToolResultError,
  NormalizedToolUse,
  NormalizedTurnDuration,
} from "../types";
import { createNormalizedSession } from "../types";

/**
 * FEA-1459 Fix 9: `codex-auto-review` is a reviewer label that leaks from
 * `turn_context.model`, not a real model. Token rows under this label are kept
 * (the spend is real), but it must never become the session-level `model`.
 */
const CODEX_AUTO_REVIEW_LABEL = "codex-auto-review";

/**
 * FEA-2085 (closes the FEA-2082 `token_cost.pricing_miss`): when a Codex rollout
 * carries no extractable model id, fall back to "gpt-5-codex" — the Codex CLI's
 * API-key default on macOS/Linux and a model `@pydantic/genai-prices` CAN price.
 * The previous placeholder "gpt-codex" matched no pricing entry (genai-prices
 * resolves the provider loosely via `starts_with: "gpt-"` but prices strictly via
 * exact `equals`), so it surfaced as `reason: "no_match"`.
 *
 * ⚠️ TEMPORARY CONVENTION. OpenAI renames/retires Codex model ids frequently
 * (gpt-5-codex → gpt-5.x-codex → …). When "gpt-5-codex" leaves genai-prices'
 * data, this fallback will silently mis-price or revert to a no_match — the
 * guard test in token-cost.test.ts fails first to flag it. Token rows keyed by
 * this fallback are stamped `inferred: true` so a guessed attribution stays
 * distinguishable from a genuine gpt-5-codex session. The durable fix is to
 * extract the concrete model id reliably so this fallback rarely fires.
 */
const CODEX_FALLBACK_MODEL = "gpt-5-codex";

/** Default burst-detection thresholds; the desktop shell overrides from env. */
const DEFAULT_BURST_RECORD_MIN = 20;
const DEFAULT_BURST_WINDOW_MS = 5000;

const RESPONSE_ITEM_TYPES = new Set<string>([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "local_shell_call",
  "local_shell_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
]);

// CLOSEDLOOP plan-extraction (FEA-1189): Codex emits implementation plans as a
// structured `item_completed` event whose item.type === "Plan", and (fallback)
// as a <proposed_plan> block inside an assistant message. We surface both into
// session.plans[]; plan-extractor/plan-store handle normalization + versioning.
const PROPOSED_PLAN_RE = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/i;

type Rec = Record<string, unknown>;

type ClassifyKind =
  | "session_meta"
  | "turn_context"
  | "event"
  | "response_item"
  | "auto"
  | "other";

export type Classified = {
  kind: ClassifyKind;
  p: Rec;
  ts: unknown;
};

/** Read a string field from a record, returning null when not a string. */
function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Classify a parsed JSONL record into a coarse kind plus its inner payload.
 */
export function classify(rec: unknown): Classified | null {
  const r = asRecord(rec);
  if (!r) {
    return null;
  }
  const payload = asRecord(r.payload);
  const ts =
    r.timestamp ?? r.ts ?? (payload ? payload.timestamp : undefined) ?? null;
  const t = r.type;

  if (t === "session_meta" || t === "session.created") {
    return { kind: "session_meta", p: payload ?? r, ts };
  }
  if (t === "turn_context" || t === "turn.context") {
    return { kind: "turn_context", p: payload ?? r, ts };
  }
  if (t === "event_msg" || t === "event") {
    return { kind: "event", p: payload ?? r, ts };
  }
  if (t === "response_item" || t === "response.item") {
    return { kind: "response_item", p: payload ?? r, ts };
  }

  // Unknown wrapper but a typed payload — auto-detect from payload.type.
  if (payload?.type) {
    return { kind: "auto", p: payload, ts };
  }
  // Bare Responses-API item on the line.
  if (typeof t === "string" && RESPONSE_ITEM_TYPES.has(t)) {
    return { kind: "response_item", p: r, ts };
  }
  // Bare session meta (no `type`, but session-ish fields).
  if (!t && (r.cwd || r.instructions || r.git || r.session_id || r.id)) {
    return { kind: "session_meta", p: r, ts };
  }
  // Bare event-like record.
  if (t) {
    return { kind: "event", p: r, ts };
  }
  return { kind: "other", p: payload ?? r, ts };
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const b of content) {
    if (!b) {
      continue;
    }
    if (typeof b === "string") {
      parts.push(b);
      continue;
    }
    const block = asRecord(b);
    if (!block) {
      continue;
    }
    if (typeof block.text === "string") {
      parts.push(block.text);
    } else if (
      (block.type === "input_text" ||
        block.type === "output_text" ||
        block.type === "text") &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

type CodexTokenTotals = {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  cacheWrite: number;
  nonCachedInput: number;
  outputWithReasoning: number;
};

/**
 * Read cumulative Codex token totals with canonical aliases taking precedence.
 *
 * Codex (OpenAI) reports `input_tokens` as an INCLUSIVE total (cached is a
 * subset). To satisfy the canonical fresh shape (see NormalizedTokenCounts),
 * `nonCachedInput = input - cached` is what we store as `input`, with `cached`
 * kept separately as `cacheRead`. This is the one parser that must subtract;
 * native-fresh sources (Claude, OpenCode, Cursor, Copilot) store input verbatim.
 */
function readCodexTokenTotals(totals: Rec, context: string): CodexTokenTotals {
  const input = readStorageTokenCountAlias(totals, `${context}.input`, [
    "input_tokens",
    "inputTokens",
  ]);
  const cached = readStorageTokenCountAlias(totals, `${context}.cache_read`, [
    "cached_input_tokens",
    "cachedInputTokens",
  ]);
  const output = readStorageTokenCountAlias(totals, `${context}.output`, [
    "output_tokens",
    "outputTokens",
  ]);
  const reasoning = readStorageTokenCountAlias(totals, `${context}.reasoning`, [
    "reasoning_output_tokens",
    "reasoningOutputTokens",
  ]);
  const cacheWrite = readStorageTokenCountAlias(
    totals,
    `${context}.cache_write`,
    [
      "cache_write_tokens",
      "cacheWriteTokens",
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
    ]
  );
  return {
    input,
    cached,
    output,
    reasoning,
    cacheWrite,
    nonCachedInput: subtractStorageTokenCounts(
      input,
      cached,
      `${context}.non_cached_input`
    ),
    outputWithReasoning: addStorageTokenCounts(
      output,
      reasoning,
      `${context}.output_with_reasoning`
    ),
  };
}

/** Per-turn token deltas derived from successive cumulative Codex totals. */
type CodexTokenDeltas = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** Options for the pure Codex rollout parse. */
export type ParseCodexRolloutOptions = {
  sessionId: string;
  /** Minimum records to trigger burst detection (desktop reads env; default 20). */
  burstRecordMin?: number;
  /** Burst-detection time window in ms (desktop reads env; default 5000). */
  burstWindowMs?: number;
  /** Leading cumulative usage snapshots already owned by a present parent fork. */
  replayedUsageIdentities?: ReadonlySet<string>;
};

/**
 * CR-2: compute a per-turn delta from cumulative Codex totals. With no prior
 * snapshot the current cumulative value IS the delta; otherwise subtract the
 * previous cumulative totals (clamped at 0 inside subtractStorageTokenCounts).
 */
function computeTokenDeltas(
  current: CodexTokenTotals,
  previousTotals: Rec | null
): CodexTokenDeltas {
  if (!previousTotals) {
    return {
      input: current.nonCachedInput,
      output: current.outputWithReasoning,
      cacheRead: current.cached,
      cacheWrite: current.cacheWrite,
    };
  }
  const previous = readCodexTokenTotals(previousTotals, "codex.previous");
  return {
    input: subtractStorageTokenCounts(
      current.nonCachedInput,
      previous.nonCachedInput,
      "codex.delta_input"
    ),
    output: subtractStorageTokenCounts(
      current.outputWithReasoning,
      previous.outputWithReasoning,
      "codex.delta_output"
    ),
    cacheRead: subtractStorageTokenCounts(
      current.cached,
      previous.cached,
      "codex.delta_cache_read"
    ),
    cacheWrite: subtractStorageTokenCounts(
      current.cacheWrite,
      previous.cacheWrite,
      "codex.delta_cache_write"
    ),
  };
}

function codexUsageSnapshotIdentity(
  model: string | null,
  totals: CodexTokenTotals
): string {
  return [
    model ?? "",
    totals.nonCachedInput,
    totals.cached,
    totals.outputWithReasoning,
    totals.cacheWrite,
  ].join(":");
}

/**
 * The single mutable accumulator threaded through every per-line handler. The
 * handler registries below key on item/event `type` and share this one object,
 * replacing the former pair of in-function if-cascades (FEA-520 hotspot).
 */
type RolloutAccumulator = {
  cwd: string | null;
  model: string | null;
  version: string | null;
  gitBranch: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  lastTs: string | null;
  userMessageCount: number;
  assistantMessageCount: number;
  messageTimestamps: string[];
  toolUses: NormalizedToolUse[];
  toolCallIndex: Map<string, number>;
  turnDurations: NormalizedTurnDuration[];
  plans: NormalizedPlan[]; // CLOSEDLOOP plan-extraction (FEA-1189)
  apiErrors: NormalizedApiError[];
  thinkingBlockCount: number;
  toolResultErrors: NormalizedToolResultError[];
  previousTotals: Rec | null; // CR-2: previous cumulative totals for delta computation
  sawResponseItems: boolean;
  pendingTurnStartedAt: string | null;
  messages: NormalizedMessage[]; // CR-1
  tokenSeries: NormalizedTokenRecord[]; // CR-2
  deferredTokenDelta: CodexTokenDeltas | null; // FEA-2343: untimestamped leading delta
  forkReplayMatching: boolean;
  replayedUsageIdentities: ReadonlySet<string> | null;
  diffStats: NormalizedDiffStats | null; // CR-4
  /** CR-5: per-event model from turn_context; reset on each turn_context line. */
  currentTurnModel: string | null;
  /**
   * FEA-2641: session_meta.originator — how the session was launched, stamped
   * by Codex itself (census over 1,555 local rollouts: codex_exec /
   * claude-codex-exec = scripted; codex-tui / codex_cli_rs / codex_vscode =
   * interactive). Becomes the session entrypoint so downstream attribution can
   * tell headless runs from keyboard sessions without inspecting prompt text.
   */
  originator: string | null;
  /**
   * FEA-2641: Codex emits an `event_msg`/`user_message` record ONLY for
   * prompts a user actually submitted; injected context (the AGENTS.md
   * instructions blob, <environment_context>) appears only as a
   * `response_item` user message with no event twin. Trimmed event texts are
   * collected here (text → pending count) and consumed against response_item
   * user messages at finalize — a structural discriminator, deliberately not
   * prompt-prose matching.
   */
  emUserTexts: Map<string, number>;
  emUserCount: number;
  /** response_item-derived human messages with their raw (pre-truncation) text. */
  humanMessageRefs: Array<{ msg: NormalizedMessage; raw: string }>;
};

function createAccumulator(
  options: { replayedUsageIdentities?: ReadonlySet<string> } = {}
): RolloutAccumulator {
  return {
    cwd: null,
    model: null,
    version: null,
    gitBranch: null,
    firstTimestamp: null,
    lastTimestamp: null,
    lastTs: null,
    userMessageCount: 0,
    assistantMessageCount: 0,
    messageTimestamps: [],
    toolUses: [],
    toolCallIndex: new Map<string, number>(),
    turnDurations: [],
    plans: [],
    apiErrors: [],
    thinkingBlockCount: 0,
    toolResultErrors: [],
    previousTotals: null,
    sawResponseItems: false,
    pendingTurnStartedAt: null,
    messages: [],
    tokenSeries: [],
    deferredTokenDelta: null,
    forkReplayMatching: options.replayedUsageIdentities != null,
    replayedUsageIdentities: options.replayedUsageIdentities ?? null,
    diffStats: null,
    currentTurnModel: null,
    originator: null,
    emUserTexts: new Map<string, number>(),
    emUserCount: 0,
    humanMessageRefs: [],
  };
}

/** A per-line handler keyed by item/event `type` in the registries below. */
type RolloutHandler = (
  acc: RolloutAccumulator,
  p: Rec,
  iso: string | null,
  explicitIso: string | null
) => void;

/**
 * Track a record's timestamp, advancing the shared session span (first/last)
 * and Codex's extra `lastTs` cursor. The span min/max is the shared
 * `foldTimestampBounds`; `lastTs` is Codex-specific so it stays here.
 */
function noteTimestamp(acc: RolloutAccumulator, raw: unknown): string | null {
  const iso = foldTimestampBounds(acc, raw);
  if (iso) {
    acc.lastTs = iso;
  }
  return iso;
}

/**
 * CR-4: parse a unified-diff string, merge its file/line counts into the
 * session-level diffStats accumulator, and return the per-tool delta so the
 * caller can stamp `tu.diffDelta`.
 */
function mergeDiffDelta(
  acc: RolloutAccumulator,
  rawDiff: string
): { add: number; del: number } {
  const delta = computeUnifiedDiffDelta(rawDiff);
  const files = countDiffFiles(rawDiff);
  if (acc.diffStats) {
    acc.diffStats.filesChanged += files;
    acc.diffStats.linesAdded += delta.add;
    acc.diffStats.linesRemoved += delta.del;
  } else {
    acc.diffStats = {
      filesChanged: files,
      linesAdded: delta.add,
      linesRemoved: delta.del,
    };
  }
  return delta;
}

// ── response_item handlers ────────────────────────────────────────────────
// Each handles one Responses-API item type, sharing the mutable accumulator.

const handleMessageItem: RolloutHandler = (acc, p, iso, explicitIso) => {
  const role = asStr(p.role) ?? asStr(p.author) ?? "assistant";
  const text = extractText(p.content);
  if (role === "user") {
    acc.userMessageCount++;
    if (explicitIso) {
      acc.pendingTurnStartedAt = explicitIso;
    }
    // CR-1: capture user message
    const userModel = acc.currentTurnModel ?? acc.model;
    const humanMsg: NormalizedMessage = {
      role: "human",
      timestamp: iso || acc.firstTimestamp,
      text: truncateText(text),
      model: userModel,
      ...(userModel && isSyntheticModelKey(userModel)
        ? { isSynthetic: true }
        : {}),
    };
    acc.messages.push(humanMsg);
    // FEA-2641: keep the raw text so finalize can match this message against
    // the event_msg/user_message stream (injected-context exclusion).
    acc.humanMessageRefs.push({ msg: humanMsg, raw: text });
  } else {
    acc.assistantMessageCount++;
    if (iso) {
      acc.messageTimestamps.push(iso);
    }
    pushTurnDuration(acc.turnDurations, acc.pendingTurnStartedAt, iso);
    acc.pendingTurnStartedAt = null;
    // Fallback plan signal: <proposed_plan> block in an assistant message
    // (medium confidence — flagged for user confirmation downstream).
    const pm = PROPOSED_PLAN_RE.exec(text);
    if (pm?.[1]?.trim()) {
      acc.plans.push({
        source: "codex-proposed-plan",
        content: pm[1].trim(),
        timestamp: iso || acc.firstTimestamp,
      });
    }
    // CR-1: capture assistant message
    const assistantModel = acc.currentTurnModel ?? acc.model;
    acc.messages.push({
      role: "assistant",
      timestamp: iso || acc.firstTimestamp,
      text: truncateText(text),
      model: assistantModel,
      ...(assistantModel && isSyntheticModelKey(assistantModel)
        ? { isSynthetic: true }
        : {}),
    });
  }
};

const handleReasoningItem: RolloutHandler = (acc, p, iso) => {
  acc.thinkingBlockCount++;
  // CR-1: capture reasoning as a thinking message
  const reasoningText =
    extractText(p.content) || asStr(p.text) || asStr(p.summary) || null;
  const thinkingModel = acc.currentTurnModel ?? acc.model;
  acc.messages.push({
    role: "assistant",
    timestamp: iso || acc.firstTimestamp,
    text: truncateText(reasoningText),
    model: thinkingModel,
    isThinking: true,
    ...(thinkingModel && isSyntheticModelKey(thinkingModel)
      ? { isSynthetic: true }
      : {}),
  });
};

const handleToolCallItem: RolloutHandler = (acc, p, iso) => {
  const toolName = asStr(p.name) ?? asStr(p.tool_name) ?? "function";
  const toolInput = safeJson(p.arguments == null ? p.input : p.arguments);
  const callId = asStr(p.call_id) ?? asStr(p.id) ?? null;
  const tu: NormalizedToolUse = {
    name: toolName,
    timestamp: iso || acc.firstTimestamp,
    input: toolInput,
  };
  // CR-4: parse apply_patch input as unified diff
  if (toolName === "apply_patch") {
    const rawInput =
      typeof p.arguments === "string"
        ? p.arguments
        : typeof p.input === "string"
          ? p.input
          : typeof toolInput === "string"
            ? toolInput
            : null;
    if (rawInput) {
      tu.diffDelta = mergeDiffDelta(acc, rawInput);
    }
  }
  if (callId) {
    acc.toolCallIndex.set(callId, acc.toolUses.length);
  }
  acc.toolUses.push(tu);
};

const handleShellCallItem: RolloutHandler = (acc, p, iso) => {
  const shellCallId = asStr(p.call_id) ?? asStr(p.id) ?? null;
  const action = asRecord(p.action) ?? {};
  const shellTu: NormalizedToolUse = {
    name: "shell",
    timestamp: iso || acc.firstTimestamp,
    input: action.command || p.action || p.input || null,
  };
  if (shellCallId) {
    acc.toolCallIndex.set(shellCallId, acc.toolUses.length);
  }
  acc.toolUses.push(shellTu);
};

const handleToolOutputItem: RolloutHandler = (acc, p, iso) => {
  const out = p.output ?? p.result ?? {};
  const outRec = asRecord(out);
  const isErr = outRec
    ? outRec.success === false || outRec.is_error === true || !!outRec.error
    : false;
  // CR-3: match tool output by call ID when available, fall back to most recent
  const outputStr = typeof out === "string" ? out : JSON.stringify(out);
  const truncatedOutput = truncateText(outputStr);
  const outputCallId = asStr(p.call_id) ?? asStr(p.id) ?? null;
  const matchIdx =
    outputCallId == null ? undefined : acc.toolCallIndex.get(outputCallId);
  const matchedTool =
    matchIdx == null ? acc.toolUses.at(-1) : acc.toolUses[matchIdx];
  if (matchedTool) {
    matchedTool.output = truncatedOutput;
    matchedTool.isError = isErr;
  }
  if (isErr) {
    const content =
      typeof out === "string"
        ? out.slice(0, 500)
        : JSON.stringify(out).slice(0, 500);
    acc.toolResultErrors.push({ content, timestamp: iso });
  }
};

const RESPONSE_ITEM_HANDLERS: Record<string, RolloutHandler> = {
  message: handleMessageItem,
  reasoning: handleReasoningItem,
  function_call: handleToolCallItem,
  custom_tool_call: handleToolCallItem,
  local_shell_call: handleShellCallItem,
  function_call_output: handleToolOutputItem,
  custom_tool_call_output: handleToolOutputItem,
  local_shell_call_output: handleToolOutputItem,
};

/** Dispatch a response_item payload by its `type` to the shared registry. */
function dispatchResponseItem(
  acc: RolloutAccumulator,
  p: Rec,
  iso: string | null,
  explicitIso: string | null
): void {
  acc.sawResponseItems = true;
  RESPONSE_ITEM_HANDLERS[asStr(p.type) ?? ""]?.(acc, p, iso, explicitIso);
}

// ── event_msg handlers ──────────────────────────────────────────────────────
// Each handles one Codex event type, sharing the mutable accumulator.

const handleItemCompletedEvent: RolloutHandler = (acc, p, iso) => {
  // CLOSEDLOOP plan-extraction (FEA-1189): the strongest Codex plan signal —
  // a structured item_completed event carrying item.type === "Plan".
  const item = asRecord(p.item);
  if (
    item &&
    item.type === "Plan" &&
    typeof item.text === "string" &&
    item.text.trim()
  ) {
    acc.plans.push({
      source: "codex-plan-item",
      content: item.text,
      timestamp: iso || acc.firstTimestamp,
    });
  }
};

const handleUserMessageEvent: RolloutHandler = (acc, p, _iso, explicitIso) => {
  acc.userMessageCount++;
  if (explicitIso) {
    acc.pendingTurnStartedAt = explicitIso;
  }
  // FEA-2641: record the submitted-prompt text so finalize can tell genuine
  // response_item user messages from injected context (see emUserTexts doc).
  acc.emUserCount++;
  const text = asStr(p.message);
  if (text) {
    const key = text.trim();
    acc.emUserTexts.set(key, (acc.emUserTexts.get(key) ?? 0) + 1);
  }
};

const handleAgentMessageEvent: RolloutHandler = (acc, p, iso) => {
  if (asStr(p.type) === "agent_message") {
    acc.assistantMessageCount++;
    if (iso) {
      acc.messageTimestamps.push(iso);
    }
    pushTurnDuration(acc.turnDurations, acc.pendingTurnStartedAt, iso);
    acc.pendingTurnStartedAt = null;
  }
};

const handleAgentReasoningEvent: RolloutHandler = (acc, p) => {
  if (asStr(p.type) === "agent_reasoning") {
    acc.thinkingBlockCount++;
  }
};

/**
 * CR-5/FEA-1459 Fix 9: extract a per-event model from turn_context (then
 * info/payload), promoting it to the session model unless it is the
 * codex-auto-review reviewer label. Returns the extracted candidate (or null).
 */
function extractEventModel(
  acc: RolloutAccumulator,
  p: Rec,
  info: Rec
): string | null {
  const turnCtx = asRecord(p.turn_context);
  const m =
    (turnCtx && asStr(turnCtx.model)) || asStr(info.model) || asStr(p.model);
  if (m && m !== CODEX_AUTO_REVIEW_LABEL) {
    acc.model = m;
  }
  return m;
}

const handleTokenCountEvent: RolloutHandler = (acc, p, iso) => {
  const info = asRecord(p.info) ?? asRecord(p.token_count_info) ?? p;
  const totals =
    asRecord(info.total_token_usage) ??
    asRecord(info.totalTokenUsage) ??
    asRecord(info.total);
  // FEA-1459 Fix 9: Skip codex-auto-review for session-level model. Done first
  // so the no-totals case still captures the model.
  const m = extractEventModel(acc, p, info);
  if (!totals) {
    return;
  }
  // CR-2: compute per-turn delta from cumulative totals
  const current = readCodexTokenTotals(totals, "codex.current");
  const identity = codexUsageSnapshotIdentity(m ?? acc.model, current);
  if (acc.forkReplayMatching && acc.replayedUsageIdentities?.has(identity)) {
    acc.previousTotals = totals;
    return;
  }
  acc.forkReplayMatching = false;
  const delta = computeTokenDeltas(current, acc.previousTotals);
  acc.previousTotals = totals;

  // FEA-2085: no extractable per-event or session model → priceable
  // fallback, flagged as an inferred (guessed) attribution.
  const eventInferred = !(m ?? acc.model);
  const eventModel = m ?? acc.model ?? CODEX_FALLBACK_MODEL;

  const hasTokens =
    delta.input || delta.output || delta.cacheRead || delta.cacheWrite;
  if (!iso && hasTokens) {
    // FEA-2343: defer untimestamped deltas until a timestamp is available.
    const d = acc.deferredTokenDelta;
    acc.deferredTokenDelta = {
      input: d ? d.input + delta.input : delta.input,
      output: d ? d.output + delta.output : delta.output,
      cacheRead: d ? d.cacheRead + delta.cacheRead : delta.cacheRead,
      cacheWrite: d ? d.cacheWrite + delta.cacheWrite : delta.cacheWrite,
    };
  } else if (iso && hasTokens) {
    const deferred = acc.deferredTokenDelta;
    acc.deferredTokenDelta = null;
    acc.tokenSeries.push({
      timestamp: iso,
      model: eventModel,
      input: delta.input + (deferred?.input ?? 0),
      output: delta.output + (deferred?.output ?? 0),
      cacheRead: delta.cacheRead + (deferred?.cacheRead ?? 0),
      cacheWrite: delta.cacheWrite + (deferred?.cacheWrite ?? 0),
      ...(eventInferred ? { inferred: true } : {}),
    });
  }
};

const handleErrorEvent: RolloutHandler = (acc, p, iso) => {
  acc.apiErrors.push({
    type: asStr(p.type) ?? "error",
    message:
      (typeof p.message === "string" && p.message) ||
      asStr(p.error) ||
      "Codex error",
    timestamp: iso,
  });
};

/**
 * Fallback only for older event-only logs with no response_item items:
 * synthesize tool uses from exec/patch/mcp begin events.
 */
const handleToolBeginFallbackEvent: RolloutHandler = (acc, p, iso) => {
  if (acc.sawResponseItems) {
    return;
  }
  const et = asStr(p.type);
  if (et === "mcp_tool_call_begin") {
    // CR-6: preserve MCP server and method from the event payload
    const server = asStr(p.server) ?? asStr(p.mcp_server) ?? undefined;
    const method =
      asStr(p.method) ?? asStr(p.tool) ?? asStr(p.tool_name) ?? undefined;
    const displayName =
      server && method
        ? `${server}__${method}`
        : (method ?? server ?? "mcp_tool");
    acc.toolUses.push({
      name: displayName,
      timestamp: iso || acc.firstTimestamp,
      input: p.arguments ?? p.input ?? null,
      mcpServer: server,
      mcpMethod: method,
    });
  } else if (et === "patch_apply_begin") {
    // CR-4: parse the patch input for diff stats
    const patchInput =
      typeof p.changes === "string"
        ? p.changes
        : typeof p.patch === "string"
          ? p.patch
          : typeof p.arguments === "string"
            ? p.arguments
            : null;
    const tu: NormalizedToolUse = {
      name: "apply_patch",
      timestamp: iso || acc.firstTimestamp,
      input: p.changes ?? p.patch ?? p.arguments ?? null,
    };
    if (patchInput) {
      // Aggregate into session-level diffStats
      tu.diffDelta = mergeDiffDelta(acc, patchInput);
    }
    acc.toolUses.push(tu);
  } else {
    acc.toolUses.push({
      name: "shell",
      timestamp: iso || acc.firstTimestamp,
      input: p.command ?? p.arguments ?? null,
    });
  }
};

const handleMcpToolCallEndEvent: RolloutHandler = (acc, p, iso) => {
  // CR-6: match MCP end event to the most recent MCP tool use and capture output
  const out = p.output ?? p.result ?? undefined;
  const outRec = asRecord(out);
  const isErr = outRec
    ? outRec.success === false || outRec.is_error === true || !!outRec.error
    : false;
  // Find the last MCP tool use that hasn't been matched yet (no output set).
  // This guards against interleaved MCP calls (A begin, B begin, A end, B end)
  // where a naive backward scan would attach A's output to B.
  for (let i = acc.toolUses.length - 1; i >= 0; i--) {
    if (
      (acc.toolUses[i].mcpServer != null ||
        acc.toolUses[i].mcpMethod != null) &&
      acc.toolUses[i].output === undefined
    ) {
      if (out !== undefined) {
        const outputStr = typeof out === "string" ? out : JSON.stringify(out);
        acc.toolUses[i].output = truncateText(outputStr);
        acc.toolUses[i].isError = isErr;
      }
      break;
    }
  }
  if (isErr) {
    const content =
      typeof out === "string"
        ? out.slice(0, 500)
        : JSON.stringify(out ?? {}).slice(0, 500);
    acc.toolResultErrors.push({ content, timestamp: iso });
  }
};

const EVENT_HANDLERS: Record<string, RolloutHandler> = {
  item_completed: handleItemCompletedEvent,
  user_message: handleUserMessageEvent,
  agent_message: handleAgentMessageEvent,
  agent_message_delta: handleAgentMessageEvent,
  agent_reasoning: handleAgentReasoningEvent,
  agent_reasoning_section_break: handleAgentReasoningEvent,
  token_count: handleTokenCountEvent,
  error: handleErrorEvent,
  stream_error: handleErrorEvent,
  exec_command_begin: handleToolBeginFallbackEvent,
  patch_apply_begin: handleToolBeginFallbackEvent,
  mcp_tool_call_begin: handleToolBeginFallbackEvent,
  mcp_tool_call_end: handleMcpToolCallEndEvent,
};

/** Dispatch an event_msg payload by its `type` to the shared registry. */
function dispatchEvent(
  acc: RolloutAccumulator,
  p: Rec,
  iso: string | null,
  explicitIso: string | null
): void {
  const et = asStr(p.type);
  if (!et) {
    return;
  }
  EVENT_HANDLERS[et]?.(acc, p, iso, explicitIso);
}

/** Apply a session_meta record's metadata fields (first non-null wins). */
function applySessionMeta(acc: RolloutAccumulator, p: Rec): void {
  if (!acc.cwd && (p.cwd || p.workdir)) {
    acc.cwd = asStr(p.cwd) ?? asStr(p.workdir);
  }
  // FEA-2641: launch-mode discriminator (see RolloutAccumulator.originator).
  if (!acc.originator && p.originator) {
    acc.originator = asStr(p.originator);
  }
  if (!acc.version && (p.cli_version || p.version)) {
    acc.version = asStr(p.cli_version) ?? asStr(p.version);
  }
  if (!acc.gitBranch) {
    const git = asRecord(p.git);
    if (git) {
      acc.gitBranch = asStr(git.branch) ?? asStr(git.ref) ?? null;
    } else if (typeof p.git_branch === "string") {
      acc.gitBranch = p.git_branch;
    }
  }
  if (!acc.model && p.model) {
    const sessionMetaModel = asStr(p.model);
    if (sessionMetaModel && sessionMetaModel !== CODEX_AUTO_REVIEW_LABEL) {
      acc.model = sessionMetaModel;
    }
  }
}

/** Apply a turn_context record: turn_context.model is authoritative (CR-5). */
function applyTurnContext(acc: RolloutAccumulator, p: Rec): void {
  // CR-5: turn_context.model is authoritative per CodexBar docs.
  // FEA-1459 Fix 9: Skip codex-auto-review (reviewer label, not a model).
  const turnModel = asStr(p.model);
  if (turnModel && turnModel !== CODEX_AUTO_REVIEW_LABEL) {
    acc.model = turnModel;
  }
  if (turnModel) {
    acc.currentTurnModel = turnModel;
  }
  if (!acc.cwd && p.cwd) {
    acc.cwd = asStr(p.cwd);
  }
}

/**
 * FEA-2641: drop injected-context user messages from the human record.
 *
 * Codex reuses the `user` role on response_items for context it injects
 * itself — the `# AGENTS.md instructions` blob and `<environment_context>` —
 * which over-counts human turns everywhere downstream (is_human
 * classification, the activity heatmap's Human series, userMessages). The
 * discriminator is structural, not textual: Codex emits an
 * `event_msg`/`user_message` record ONLY for prompts actually submitted
 * (typed or scripted), never for injected context. Each event text is
 * consumed against at most one response_item user message (count-per-text,
 * mirroring the claude-parser scheduledPrompts semantics) so repeated
 * identical prompts stay counted.
 *
 * Rollouts with NO user_message events at all (3 of 1,555 in the local
 * census — aborted/legacy files) keep the response_item-derived messages
 * unchanged, so old formats can never lose genuine turns. When events exist,
 * userMessageCount is normalized to the event count — the double increment
 * from handleMessageItem + handleUserMessageEvent previously over-counted
 * modern rollouts.
 */
function filterInjectedUserMessages(acc: RolloutAccumulator): void {
  if (acc.emUserCount === 0) {
    return;
  }
  const injected = new Set<NormalizedMessage>();
  for (const ref of acc.humanMessageRefs) {
    const key = ref.raw.trim();
    const pending = acc.emUserTexts.get(key);
    if (pending) {
      if (pending === 1) {
        acc.emUserTexts.delete(key);
      } else {
        acc.emUserTexts.set(key, pending - 1);
      }
    } else {
      injected.add(ref.msg);
    }
  }
  if (injected.size > 0) {
    acc.messages = acc.messages.filter((m) => !injected.has(m));
  }
  acc.userMessageCount = acc.emUserCount;
}

/** Dispatch a single classified rollout line into the accumulator. */
function dispatchLine(
  acc: RolloutAccumulator,
  c: Classified,
  iso: string | null,
  explicitIso: string | null
): void {
  switch (c.kind) {
    case "session_meta":
      applySessionMeta(acc, c.p);
      break;
    case "turn_context":
      applyTurnContext(acc, c.p);
      break;
    case "response_item":
      dispatchResponseItem(acc, c.p, iso, explicitIso);
      break;
    case "event":
      dispatchEvent(acc, c.p, iso, explicitIso);
      break;
    case "auto":
      if (typeof c.p.type === "string" && RESPONSE_ITEM_TYPES.has(c.p.type)) {
        dispatchResponseItem(acc, c.p, iso, explicitIso);
      } else {
        dispatchEvent(acc, c.p, iso, explicitIso);
      }
      break;
    default:
      // "other" — no usable kind; ignored.
      break;
  }
}

/**
 * FEA-1459 Fix 4: a re-serialized rollout burst produces duplicate sessions
 * (39 sessions in 91s on 2026-05-22, every record stamped within ~350ms;
 * 32/223 codex sessions had <2s span with >50 events). These are resume/fork
 * artifacts, not real sessions. Threshold 20: real records require API
 * round-trips, so 20+ records can never fit in 5s; a re-audit with >=50 left 26
 * sub-second fragments (<=23 records) alive while the one genuine session in
 * the burst window (54 records over 945s) sails through either threshold.
 */
function isBurstSession(
  acc: RolloutAccumulator,
  burstRecordMin: number,
  burstWindowMs: number
): boolean {
  if (!(acc.firstTimestamp && acc.lastTimestamp)) {
    return false;
  }
  const span =
    new Date(acc.lastTimestamp).getTime() -
    new Date(acc.firstTimestamp).getTime();
  const recordCount =
    acc.messages.length +
    acc.toolUses.length +
    acc.tokenSeries.length +
    acc.turnDurations.length;
  return recordCount >= burstRecordMin && span < burstWindowMs;
}

/**
 * FEA-1459 (PR #1511 review): a RESUMED burst rollout replays the original
 * session's records in a tight leading burst, then appends real work. The
 * whole-file span check ({@link isBurstSession}) no longer fires (span > 5s),
 * but the replayed token_counts would re-import the original session's
 * cumulative totals — the first one as a single giant delta — double-counting
 * spend the original rollout file already owns. Detect a >=20-record burst
 * inside the first 5s and drop its token entries from `acc.tokenSeries`.
 * Since buildTokensByModel sums tokenSeries (FEA-2343), filtering the
 * replayed entries is sufficient — no baseline subtraction needed.
 */
function rebaseReplayedBurst(
  acc: RolloutAccumulator,
  burstRecordMin: number,
  burstWindowMs: number
): void {
  if (!acc.firstTimestamp) {
    return;
  }
  const startMs = new Date(acc.firstTimestamp).getTime();
  const inLeadingBurst = (ts: string | null | undefined): boolean =>
    typeof ts === "string" && new Date(ts).getTime() - startMs < burstWindowMs;
  const burstRecordCount =
    acc.messages.filter((m) => inLeadingBurst(m.timestamp)).length +
    acc.toolUses.filter((tu) => inLeadingBurst(tu.timestamp)).length +
    acc.tokenSeries.filter((e) => inLeadingBurst(e.timestamp)).length +
    acc.turnDurations.filter((td) => inLeadingBurst(td.timestamp)).length;
  if (burstRecordCount < burstRecordMin) {
    return;
  }
  if (!acc.tokenSeries.some((e) => inLeadingBurst(e.timestamp))) {
    return;
  }
  let writeIdx = 0;
  for (const e of acc.tokenSeries) {
    if (!inLeadingBurst(e.timestamp)) {
      acc.tokenSeries[writeIdx++] = e;
    }
  }
  acc.tokenSeries.length = writeIdx;
}

/**
 * Build model-keyed token totals by summing per-turn deltas from
 * `acc.tokenSeries`. The series is already rebased (burst/fork replay
 * entries filtered) and clamped (counter-reset deltas are 0), so the
 * sum is the correct session total. This matches the Claude parser's
 * delta-based approach (foldDedupMap) and eliminates the class of
 * cumulative-vs-delta divergence bugs (FEA-2343).
 */
function buildTokensByModel(
  acc: RolloutAccumulator
): Record<string, NormalizedTokenCounts> {
  const tokensByModel: Record<string, NormalizedTokenCounts> = {};
  for (const entry of acc.tokenSeries) {
    // FEA-1459 Fix 9: codex-auto-review is a reviewer label, not a real
    // model. Remap its tokens to the session model or priceable fallback
    // so importSessionWithTx never backfills sessions.model from it.
    const key =
      entry.model === CODEX_AUTO_REVIEW_LABEL
        ? (acc.model ?? CODEX_FALLBACK_MODEL)
        : entry.model;
    const inferred =
      entry.model === CODEX_AUTO_REVIEW_LABEL && !acc.model
        ? true
        : entry.inferred;
    const existing = tokensByModel[key];
    tokensByModel[key] = {
      input: addStorageTokenCounts(
        existing?.input ?? 0,
        entry.input,
        "codex.fold_input"
      ),
      output: addStorageTokenCounts(
        existing?.output ?? 0,
        entry.output,
        "codex.fold_output"
      ),
      cacheRead: addStorageTokenCounts(
        existing?.cacheRead ?? 0,
        entry.cacheRead,
        "codex.fold_cache_read"
      ),
      cacheWrite: addStorageTokenCounts(
        existing?.cacheWrite ?? 0,
        entry.cacheWrite,
        "codex.fold_cache_write"
      ),
      ...(existing?.inferred || inferred ? { inferred: true } : {}),
    };
  }
  return tokensByModel;
}

function extractEventModelForIdentity(p: Rec, info: Rec): string | null {
  const turnCtx = asRecord(p.turn_context);
  const model =
    (turnCtx && asStr(turnCtx.model)) || asStr(info.model) || asStr(p.model);
  return model && model !== CODEX_AUTO_REVIEW_LABEL ? model : null;
}

/**
 * Parse a single Codex rollout (an async/sync iterable of JSONL lines) into the
 * normalized session object. Returns null when the rollout carries no usable
 * timestamp (mirrors the Claude parser's contract so importSession can treat
 * both identically).
 *
 * This is the single-rollout core. The desktop shell wraps it to stream a file,
 * merge companion workflow-journal tokens, and stamp `fileModifiedAt` — behavior
 * that is DB-import-specific and not part of the cloud renderer's per-file parse.
 */
export async function parseCodexRollout(
  lines: AsyncIterable<string> | Iterable<string>,
  options: ParseCodexRolloutOptions
): Promise<NormalizedSession | null> {
  const { sessionId } = options;
  const burstRecordMin = options.burstRecordMin ?? DEFAULT_BURST_RECORD_MIN;
  const burstWindowMs = options.burstWindowMs ?? DEFAULT_BURST_WINDOW_MS;

  const acc = createAccumulator({
    replayedUsageIdentities: options.replayedUsageIdentities,
  });

  // FEA-2907: track malformed-line drops so the session carries a parse-quality
  // signal at parity with the Claude parser (FEA-2771). A malformed FINAL line
  // is the benign shape of a truncated in-progress rollout; a malformed line
  // anywhere earlier silently loses that turn's token usage and events
  // (apiErrors stays empty), so it must be surfaced. Counting mirrors the
  // desktop `readJsonlLinesWithQuality` scan so the shared contract holds on
  // both surfaces.
  let totalLines = 0;
  let malformedLines = 0;
  let lastLineMalformed = false;

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    totalLines++;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      malformedLines++;
      lastLineMalformed = true;
      continue;
    }
    lastLineMalformed = false;
    const c = classify(rec);
    if (!c) {
      continue;
    }
    const explicitIso = noteTimestamp(acc, c.ts);
    const iso = explicitIso || acc.lastTs;
    dispatchLine(acc, c, iso, explicitIso);
  }

  if (!acc.firstTimestamp) {
    return null;
  }

  if (isBurstSession(acc, burstRecordMin, burstWindowMs)) {
    return null;
  }

  // FEA-2343: flush any untimestamped leading token deltas that were never
  // folded into a timestamped entry during the parsing loop.
  if (acc.deferredTokenDelta) {
    const ts = acc.lastTs ?? acc.firstTimestamp;
    if (ts) {
      const d = acc.deferredTokenDelta;
      const eventModel = acc.model ?? CODEX_FALLBACK_MODEL;
      const eventInferred = !acc.model;
      acc.tokenSeries.push({
        timestamp: ts,
        model: eventModel,
        input: d.input,
        output: d.output,
        cacheRead: d.cacheRead,
        cacheWrite: d.cacheWrite,
        ...(eventInferred ? { inferred: true } : {}),
      });
    }
    acc.deferredTokenDelta = null;
  }

  rebaseReplayedBurst(acc, burstRecordMin, burstWindowMs);

  filterInjectedUserMessages(acc);

  const tokensByModel = buildTokensByModel(acc);

  // CR-13: collect artifact references from all tool uses
  const artifacts: NormalizedArtifacts = collectArtifacts(
    acc.toolUses,
    acc.cwd
  );

  const projectName = acc.cwd
    ? baseName(acc.cwd)
    : `Codex Session ${sessionId.slice(0, 8)}`;

  // Unset fields are filled by createNormalizedSession's defaults. The desktop
  // shell merges companion workflow-journal tokens and stamps the source mtime;
  // the cloud renderer has no local file, so the core leaves those alone.
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
    plans: acc.plans,
    apiErrors: acc.apiErrors,
    fileModifiedAt: null,
    turnDurations: acc.turnDurations,
    // FEA-2641: the Codex-stamped launch mode (session_meta.originator) is the
    // entrypoint, so headless runs (codex_exec, *-exec wrappers) are
    // distinguishable from keyboard sessions (codex-tui, codex_cli_rs,
    // codex_vscode) downstream. "codex" only for rollouts predating the field.
    entrypoint: acc.originator ?? "codex",
    thinkingBlockCount: acc.thinkingBlockCount,
    toolResultErrors: acc.toolResultErrors,
    messages: acc.messages, // CR-1
    tokenSeries: acc.tokenSeries, // CR-2
    diffStats: acc.diffStats, // CR-4
    artifacts, // CR-13
    // FEA-2907: parse-quality signal (malformed-line drops, truncated final line)
    // at parity with the Claude parser (FEA-2771).
    parseQuality: {
      totalLines,
      malformedLines,
      truncatedFinalLine: lastLineMalformed,
    },
  });
}

/**
 * Collect the cumulative-usage snapshot identities from a Codex rollout's lines,
 * used by the desktop collector's fork/replay dedup (a resumed rollout replays
 * the parent's leading token_count snapshots). Pure over the lines; the desktop
 * shell wraps it with file streaming.
 */
export async function collectCodexUsageIdentities(
  lines: AsyncIterable<string> | Iterable<string>
): Promise<Set<string>> {
  const identities = new Set<string>();
  let model: string | null = null;
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const c = classify(rec);
    if (!c) {
      continue;
    }
    if (c.kind === "turn_context") {
      const turnModel = asStr(c.p.model);
      if (turnModel && turnModel !== CODEX_AUTO_REVIEW_LABEL) {
        model = turnModel;
      }
      continue;
    }
    if (c.kind !== "event" && c.kind !== "auto") {
      continue;
    }
    const eventType = asStr(c.p.type);
    if (eventType !== "token_count") {
      continue;
    }
    const info = asRecord(c.p.info) ?? asRecord(c.p.token_count_info) ?? c.p;
    const totals =
      asRecord(info.total_token_usage) ??
      asRecord(info.totalTokenUsage) ??
      asRecord(info.total);
    if (!totals) {
      continue;
    }
    const eventModel = extractEventModelForIdentity(c.p, info) ?? model;
    identities.add(
      codexUsageSnapshotIdentity(
        eventModel,
        readCodexTokenTotals(totals, "codex.identity")
      )
    );
  }
  return identities;
}

/**
 * @file codex-accumulator.ts
 * @description The shared foundation of the Codex rollout parser: the record
 * primitives every handler reads fields with (`asStr` / `readCallId` /
 * `asNonNegInt` / `extractText`), the `classify` envelope reader, and the single
 * mutable `RolloutAccumulator` threaded through every per-line handler.
 *
 * Split out of `parse-codex.ts` for ISS-7623 (pure code motion, no behavior
 * change), mirroring `../claude/parse-claude-accumulator.ts` — which is likewise
 * the home for the Claude parser's shared constants and accumulator. Nothing
 * here imports `parse-codex.ts`, so the driver stays the only entrypoint.
 */

import { noteTimestamp as foldTimestampBounds } from "../parser-utils";
import { asRecord } from "../type-guards";
import type {
  CodexRateLimits,
  NormalizedApiError,
  NormalizedCodexTokenSnapshot,
  NormalizedDiffStats,
  NormalizedMessage,
  NormalizedPlan,
  NormalizedTokenRecord,
  NormalizedToolResultError,
  NormalizedToolUse,
  NormalizedTurnDuration,
} from "../types";
import {
  type CodexLaunchAttributionAccumulator,
  createCodexLaunchAttributionAccumulator,
} from "./codex-launch-attribution";
import type { CodexTokenDeltas } from "./codex-token-usage";

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
export const CODEX_FALLBACK_MODEL = "gpt-5-codex";

export const RESPONSE_ITEM_TYPES = new Set<string>([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "local_shell_call",
  "local_shell_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "tool_search_call",
]);

export type Rec = Record<string, unknown>;

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
export function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * FEA-3701: read a Codex record's model-visible / runtime tool-call id. Codex
 * carries it as `call_id` on `function_call` / `custom_tool_call` /
 * `local_shell_call` items and on `*_begin`/`*_end` events, falling back to the
 * item `id` on some releases. This is the identifier a tool's OUTPUT record
 * echoes, so it is the correlation key that survives interleaving. Returns null
 * for legacy identifier-free records (handled by the documented positional
 * compatibility fallback).
 */
export function readCallId(p: Rec): string | null {
  return asStr(p.call_id) ?? asStr(p.id) ?? null;
}

/**
 * FEA-3525: permissive non-negative-integer reader for enrichment scalars like
 * `model_context_window`. Returns the value only when it is a finite,
 * non-negative, integral JS number; ignores absent / null / string / float /
 * negative / non-finite inputs. Never throws — malformed enrichment must never
 * abort a rollout parse or perturb the canonical token math.
 */
export function asNonNegInt(v: unknown): number | null {
  return typeof v === "number" &&
    Number.isInteger(v) &&
    Number.isFinite(v) &&
    v >= 0
    ? v
    : null;
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

export function extractText(content: unknown): string {
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

/**
 * The single mutable accumulator threaded through every per-line handler. The
 * handler registries below key on item/event `type` and share this one object,
 * replacing the former pair of in-function if-cascades (FEA-520 hotspot).
 */
export type RolloutAccumulator = {
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
  /**
   * ISS-12552 (PRD-800 "Rollout"): read the attribution evidence (request
   * binding, result facts, code-mode MCP calls, Codex 0.163 `UserMessage`
   * items). Off, the parse is the one before PRD-800.
   */
  attributionEvidence: boolean;
  /** ISS-12552: code-mode `McpToolCall` items with no tool-stream call. */
  mcpCallEvidence: NormalizedToolUse[];
  /** ISS-12552: call ids already in `mcpCallEvidence`, for replayed items. */
  mcpCallEvidenceIds: Set<string>;
  /** ISS-12552: calls whose request's `token_usage_record` is still ahead. */
  callsAwaitingRequest: NormalizedToolUse[];
  /**
   * ISS-12552: nested calls made while two or more calls were open, each with
   * an open call whose request is still ahead; that request becomes one of the
   * nested call's candidates when it is recorded.
   */
  candidatesAwaitingRequest: {
    outer: NormalizedToolUse;
    nested: NormalizedToolUse;
  }[];
  /** ISS-12552: response ids recorded since the last usage record. */
  responsesSinceUsage: string[];
  toolCallIndex: Map<string, number>;
  /**
   * FEA-3701: call ids whose output/completion record has already been consumed.
   * A duplicate output/`mcp_tool_call_end` for an already-completed call id must
   * NOT re-correlate (idempotent) — Codex can emit a call's output both as a
   * `function_call_output` response item and as an `mcp_tool_call_end` event, and
   * resumed rollouts can replay a completed call. Tracked separately from
   * `toolCallIndex` (which stays the call→index map) so a second output for the
   * same id is recognized as a benign duplicate, not an orphan or a cross-assign.
   */
  completedCallIds: Set<string>;
  /** FEA-3701: tool-output records whose call id matched no open call (orphans). */
  orphanedToolOutputs: number;
  /**
   * FEA-3701: tool-output records with no usable identifier, correlated by the
   * legacy positional most-recent-open-call fallback (documented compat path).
   */
  ambiguousToolOutputs: number;
  turnDurations: NormalizedTurnDuration[];
  plans: NormalizedPlan[]; // CLOSEDLOOP plan-extraction (FEA-1189)
  apiErrors: NormalizedApiError[];
  thinkingBlockCount: number;
  toolResultErrors: NormalizedToolResultError[];
  previousTotals: Rec | null; // CR-2: previous cumulative totals for delta computation
  /**
   * FEA-3527: session-level `reasoning_output_tokens` — the value from the LAST
   * valid cumulative `total_token_usage` snapshot (Codex reports it cumulatively,
   * so last-wins mirrors the cumulative-total semantics). A subdivision of the
   * output total, surfaced as metadata; NEVER added to any token total.
   */
  reasoningOutputTokens: number;
  sawResponseItems: boolean;
  pendingTurnStartedAt: string | null;
  messages: NormalizedMessage[]; // CR-1
  tokenSeries: NormalizedTokenRecord[]; // CR-2
  /**
   * FEA-3608: the effective timestamp of every `token_count` event that
   * incremented `assistantMessageCount` (a billable round-trip), in event
   * order. `rebaseReplayedBurst` decrements the count by how many of these fall
   * inside the replayed leading burst — the per-EVENT count. Unlike the number
   * of removed `tokenSeries` entries (FEA-3439), this also covers zero-delta
   * (cumulative unchanged) and deferred (untimestamped) burst events, which bump
   * the count but push no `tokenSeries` entry. Each entry is the `iso` the parse
   * loop passed the handler (`explicitIso || acc.lastTs`); a null (an event
   * before any timestamp was seen) never matches the burst window.
   */
  tokenEventTimestamps: Array<string | null>;
  /**
   * FEA-3682: the cumulative `reasoning_output_tokens` snapshot of every
   * `token_count` event that bumped `assistantMessageCount`, in event order and
   * index-aligned with {@link tokenEventTimestamps}. `reasoningOutputTokens`
   * alone is a whole-file cumulative max, so a resumed session's replayed
   * leading burst leaves the parent's reasoning in it while the output total is
   * rebased to a burst-relative delta — the surfaced reasoning could then EXCEED
   * the session's own output (FEA-3527 subset-of-output invariant break) and
   * double-count the parent's reasoning. `rebaseReplayedBurst` uses this series
   * to re-derive the reasoning as a burst-baseline delta, mirroring the output
   * delta rebase.
   */
  reasoningOutputSnapshots: number[];
  // FEA-3526: authoritative per-turn `last_token_usage` snapshots (metadata).
  codexLastTokenUsage: NormalizedCodexTokenSnapshot[];
  deferredTokenDelta: CodexTokenDeltas | null; // FEA-2343: untimestamped leading delta
  forkReplayMatching: boolean;
  replayedUsageIdentities: ReadonlySet<string> | null;
  diffStats: NormalizedDiffStats | null; // CR-4
  /** FEA-3943: distinct edited-file paths, so `diffStats.filesChanged` dedups
   * across patches instead of summing per-patch header counts. */
  readonly diffFiles: Set<string>;
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
  /**
   * ISS-12552: the same submitted-prompt texts from Codex 0.163's
   * `UserMessage` items, used only when the rollout has no user_message event.
   */
  itemUserTexts: Map<string, number>;
  itemUserCount: number;
  /** response_item-derived human messages with their raw (pre-truncation) text. */
  humanMessageRefs: Array<{ msg: NormalizedMessage; raw: string }>;
  /** FEA-3127: context compactions (same entry shape as the Claude parser). */
  compactions: Array<{ uuid: string | null; timestamp: string | null }>;
  /**
   * FEA-3127: `compacted` records not yet matched by their
   * `event_msg`/`context_compacted` echo. Modern Codex writes one compaction
   * as BOTH records milliseconds apart (compacted first); the counter lets the
   * echo be consumed instead of double-counting, while an echo-only rollout
   * (counter 0) still records its compaction.
   */
  pendingCompactedEchoes: number;
  /**
   * FEA-3525: latest `info.model_context_window` (tokens) seen on a
   * `token_count` event. Non-negative integers only; null until a valid value
   * appears. Surfaced on the normalized session for context-window utilization.
   */
  modelContextWindow: number | null;
  /**
   * FEA-3524: the LATEST well-formed `rate_limits` snapshot seen on a
   * `token_count` event. Most events carry `"rate_limits":null`; a malformed or
   * absent block is skipped (last good wins), mirroring the token-count
   * hardening in `handleTokenCountEvent`. Null until a well-formed block is
   * observed.
   */
  codexRateLimits: CodexRateLimits | null;
  /**
   * FEA-3702: count of `token_count` events whose `rate_limits` block WAS present
   * but produced no structurally + semantically valid window (e.g. a non-object,
   * or every window all-null). Each is a preserved-last-good, skip-this-record
   * event — surfaced in parse quality (`malformedRateLimits`) so a single
   * malformed window is a visible data-quality signal rather than silent loss,
   * without failing the session. Absent/`null` blocks (the common shape) are NOT
   * counted.
   */
  malformedRateLimits: number;
  /**
   * FEA-3708: the rollout this session was forked/resumed from, from
   * `session_meta.forked_from_id` (first non-null wins, mirroring the other
   * session_meta fields). Null until a session_meta record carries it. Surfaced
   * on the normalized session as parent-rollout lineage/provenance.
   */
  forkedFromId: string | null;
  /** ISS-7259: launch attribution folded from this rollout's session_meta records. */
  launchAttribution: CodexLaunchAttributionAccumulator;
};

export function createAccumulator(
  options: {
    replayedUsageIdentities?: ReadonlySet<string>;
    attributionEvidence?: boolean;
  } = {}
): RolloutAccumulator {
  return {
    attributionEvidence: options.attributionEvidence ?? true,
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
    mcpCallEvidence: [],
    mcpCallEvidenceIds: new Set<string>(),
    callsAwaitingRequest: [],
    candidatesAwaitingRequest: [],
    responsesSinceUsage: [],
    toolCallIndex: new Map<string, number>(),
    completedCallIds: new Set<string>(),
    orphanedToolOutputs: 0,
    ambiguousToolOutputs: 0,
    turnDurations: [],
    plans: [],
    apiErrors: [],
    thinkingBlockCount: 0,
    toolResultErrors: [],
    previousTotals: null,
    reasoningOutputTokens: 0,
    sawResponseItems: false,
    pendingTurnStartedAt: null,
    messages: [],
    tokenSeries: [],
    tokenEventTimestamps: [],
    reasoningOutputSnapshots: [],
    codexLastTokenUsage: [],
    deferredTokenDelta: null,
    forkReplayMatching: options.replayedUsageIdentities != null,
    replayedUsageIdentities: options.replayedUsageIdentities ?? null,
    diffStats: null,
    diffFiles: new Set<string>(),
    currentTurnModel: null,
    originator: null,
    emUserTexts: new Map<string, number>(),
    emUserCount: 0,
    itemUserTexts: new Map<string, number>(),
    itemUserCount: 0,
    humanMessageRefs: [],
    compactions: [],
    pendingCompactedEchoes: 0,
    modelContextWindow: null,
    codexRateLimits: null,
    malformedRateLimits: 0,
    forkedFromId: null,
    launchAttribution: createCodexLaunchAttributionAccumulator(),
  };
}

/** A per-line handler keyed by item/event `type` in the registries below. */
export type RolloutHandler = (
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
export function noteTimestamp(
  acc: RolloutAccumulator,
  raw: unknown
): string | null {
  const iso = foldTimestampBounds(acc, raw);
  if (iso) {
    acc.lastTs = iso;
  }
  return iso;
}

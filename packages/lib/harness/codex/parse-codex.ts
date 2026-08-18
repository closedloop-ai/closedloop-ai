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
  noteTimestamp as foldTimestampBounds,
  isMeaningfulCwd,
  isSyntheticModelKey,
  pushTurnDuration,
  safeJson,
  truncateText,
} from "../parser-utils";
import {
  addStorageTokenCounts,
  InvalidTokenCountError,
  readStorageTokenCountAlias,
  subtractStorageTokenCounts,
} from "../token-counts";
import { asRecord } from "../type-guards";
import type {
  CodexRateLimits,
  CodexRateLimitWindow,
  NormalizedApiError,
  NormalizedArtifacts,
  NormalizedCodexTokenSnapshot,
  NormalizedDiffStats,
  NormalizedMessage,
  NormalizedPlan,
  NormalizedSession,
  NormalizedTokenCounts,
  NormalizedTokenCountsBare,
  NormalizedTokenRecord,
  NormalizedToolResultError,
  NormalizedToolUse,
  NormalizedTurnDuration,
} from "../types";
import { createNormalizedSession, emptyUsageExtras } from "../types";
import { mergeDiffDelta } from "./codex-diff-stats";
import { CODEX_PROTOCOL_SUPPORT } from "./codex-protocol-inventory";

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
  "tool_search_call",
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
 * FEA-3701: read a Codex record's model-visible / runtime tool-call id. Codex
 * carries it as `call_id` on `function_call` / `custom_tool_call` /
 * `local_shell_call` items and on `*_begin`/`*_end` events, falling back to the
 * item `id` on some releases. This is the identifier a tool's OUTPUT record
 * echoes, so it is the correlation key that survives interleaving. Returns null
 * for legacy identifier-free records (handled by the documented positional
 * compatibility fallback).
 */
function readCallId(p: Rec): string | null {
  return asStr(p.call_id) ?? asStr(p.id) ?? null;
}

/**
 * FEA-3525: permissive non-negative-integer reader for enrichment scalars like
 * `model_context_window`. Returns the value only when it is a finite,
 * non-negative, integral JS number; ignores absent / null / string / float /
 * negative / non-finite inputs. Never throws — malformed enrichment must never
 * abort a rollout parse or perturb the canonical token math.
 */
function asNonNegInt(v: unknown): number | null {
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
  /** Already includes reasoning_output_tokens (subset, not additive). */
  output: number;
  /**
   * FEA-3527: `reasoning_output_tokens` — a SUBDIVISION of `output` (never
   * additive to it or to any total). Read separately as metadata; must NEVER be
   * folded back into `output`, `input`, or a grand total (double-counting).
   */
  reasoningOutput: number;
  cacheWrite: number;
  nonCachedInput: number;
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
  // FEA-3527: reasoning_output_tokens is a SUBSET of output_tokens. Read it as a
  // SEPARATE metadata value only — it is deliberately NOT added to `output`
  // above (or to any total below); folding it in would double-count reasoning
  // against the canonical output figure it is already part of.
  const reasoningOutput = readStorageTokenCountAlias(
    totals,
    `${context}.reasoning_output`,
    ["reasoning_output_tokens", "reasoningOutputTokens"]
  );
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
    reasoningOutput,
    cacheWrite,
    nonCachedInput: subtractStorageTokenCounts(
      input,
      cached,
      `${context}.non_cached_input`
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
 *
 * FEA-3359: detect raw cumulative resets before per-field subtraction.
 * `nonCachedInput` is derived (input − cached), so asymmetric drops in the raw
 * counters can make it INCREASE despite a genuine counter reset — inflating the
 * session. Checking the raw counters first catches this: if any raw cumulative
 * dropped, the entire snapshot is a process restart or subagent fold and all
 * deltas are zero.
 */
function computeTokenDeltas(
  current: CodexTokenTotals,
  previousTotals: Rec | null
): CodexTokenDeltas {
  if (!previousTotals) {
    return {
      input: current.nonCachedInput,
      output: current.output,
      cacheRead: current.cached,
      cacheWrite: current.cacheWrite,
    };
  }
  const previous = readCodexTokenTotals(previousTotals, "codex.previous");
  if (
    current.input < previous.input ||
    current.output < previous.output ||
    current.cached < previous.cached ||
    current.cacheWrite < previous.cacheWrite
  ) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  return {
    input: subtractStorageTokenCounts(
      current.nonCachedInput,
      previous.nonCachedInput,
      "codex.delta_input"
    ),
    output: subtractStorageTokenCounts(
      current.output,
      previous.output,
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

/**
 * FEA-3526: Codex `token_count` events carry an authoritative per-turn
 * `last_token_usage` snapshot next to the `total_token_usage` cumulative object
 * the parser derives deltas from. This reads that snapshot with the SAME
 * hardened reader path as the cumulative totals (`readCodexTokenTotals` /
 * `InvalidTokenCountError` tolerance) and reconciles it against the delta the
 * parser derived for the same event, mirroring the "authoritative vs derived"
 * posture of Claude's `reconcileSessionCost` (PRD-538). Pure metadata: it never
 * feeds `tokenSeries` and must not alter the canonical cumulative-derived
 * totals. Returns null when the field is absent or malformed (drop-and-continue).
 */
function readCodexLastTokenSnapshot(
  info: Rec,
  model: string,
  iso: string | null,
  delta: CodexTokenDeltas
): NormalizedCodexTokenSnapshot | null {
  const last =
    asRecord(info.last_token_usage) ?? asRecord(info.lastTokenUsage) ?? null;
  if (!last) {
    return null;
  }
  let totals: CodexTokenTotals;
  try {
    totals = readCodexTokenTotals(last, "codex.last");
  } catch (error) {
    if (error instanceof InvalidTokenCountError) {
      // Same drop-this-snapshot-keep-parsing tolerance as the cumulative reader:
      // a malformed per-turn snapshot must never abort the rollout.
      return null;
    }
    throw error;
  }
  const lastTokenUsage: NormalizedTokenCountsBare = {
    input: totals.nonCachedInput,
    output: totals.output,
    cacheRead: totals.cached,
    cacheWrite: totals.cacheWrite,
  };
  return {
    timestamp: iso,
    model,
    lastTokenUsage,
    // `CodexTokenDeltas` is structurally the bare four-counter shape, so the
    // parser-derived delta is the `derivedDelta` verbatim.
    derivedDelta: delta,
    drifted: codexSnapshotDrifted(lastTokenUsage, delta),
  };
}

/**
 * FEA-3526: True when the authoritative per-turn `last_token_usage` disagrees
 * with the parser-derived cumulative delta beyond a small tolerance, on any of
 * the four canonical counters. A conservative absolute floor absorbs the
 * off-by-one rounding of the input=inclusive→non-cached subtraction; anything
 * larger is a genuine delta-reconstruction drift signal (e.g. a dropped or
 * out-of-order cumulative snapshot). Non-breaking: the flag is metadata, it does
 * not change any token total.
 */
const CODEX_SNAPSHOT_DRIFT_TOLERANCE = 1;
function codexSnapshotDrifted(
  last: NormalizedTokenCountsBare,
  delta: CodexTokenDeltas
): boolean {
  return (
    Math.abs(last.input - delta.input) > CODEX_SNAPSHOT_DRIFT_TOLERANCE ||
    Math.abs(last.output - delta.output) > CODEX_SNAPSHOT_DRIFT_TOLERANCE ||
    Math.abs(last.cacheRead - delta.cacheRead) >
      CODEX_SNAPSHOT_DRIFT_TOLERANCE ||
    Math.abs(last.cacheWrite - delta.cacheWrite) >
      CODEX_SNAPSHOT_DRIFT_TOLERANCE
  );
}

function codexUsageSnapshotIdentity(
  model: string | null,
  totals: CodexTokenTotals
): string {
  return [
    model ?? "",
    totals.nonCachedInput,
    totals.cached,
    totals.output,
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
    humanMessageRefs: [],
    compactions: [],
    pendingCompactedEchoes: 0,
    modelContextWindow: null,
    codexRateLimits: null,
    malformedRateLimits: 0,
    forkedFromId: null,
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
  const callId = readCallId(p);
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

const handleToolSearchCallItem: RolloutHandler = (acc, p, iso, explicitIso) => {
  handleToolCallItem(acc, { ...p, name: "tool_search" }, iso, explicitIso);
};

const handleShellCallItem: RolloutHandler = (acc, p, iso) => {
  const shellCallId = readCallId(p);
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

/**
 * FEA-3701: how a tool OUTPUT/completion record was correlated back to its
 * originating call. The parser prefers explicit call-id correlation and only
 * falls back to positional matching for legacy identifier-free data.
 *
 * - `by_call_id` — the record's `call_id` matched an open (not-yet-completed)
 *   call; the correct, interleave-safe path.
 * - `duplicate` — the `call_id` matched a call whose output was ALREADY
 *   recorded (a benign second output, e.g. Codex emitting both a
 *   `function_call_output` and an `mcp_tool_call_end` for one call, or a
 *   resumed rollout replaying a completed call). Idempotent: not re-applied.
 * - `orphan` — the record carried a `call_id` that matched NO known call. The
 *   old code cross-assigned this to the most recent tool (corrupting analytics);
 *   now it is dropped and counted so it never contaminates an unrelated call.
 * - `ambiguous_fallback` — the record carried no usable id, so it was matched to
 *   the most recent open call by the documented positional compatibility path.
 */
type OutputCorrelation =
  | { kind: "by_call_id"; tool: NormalizedToolUse }
  | { kind: "duplicate" }
  | { kind: "orphan" }
  | { kind: "ambiguous_fallback"; tool: NormalizedToolUse | undefined };

/**
 * FEA-3701: correlate a tool-output/-completion record to its originating call.
 *
 * Correlation is keyed on the explicit runtime `call_id` — the identifier the
 * output echoes from its begin — so it stays correct when calls INTERLEAVE
 * (A-begin, B-begin, A-end, B-end): A's output carries A's id regardless of the
 * intervening B. Only when a record carries no usable id at all does it fall
 * back to the legacy positional "most recent open call" match, for older
 * identifier-free Codex rollouts. A `call_id` that matches no open call is an
 * orphan (never cross-assigned), and a second output for an already-completed
 * id is a benign duplicate (never re-applied).
 *
 * `restrictToMcp` limits the ambiguous positional fallback to MCP-synthesized
 * tools (the `mcp_tool_call_end` event path), matching the previous handler's
 * scan and keeping response-item sessions byte-identical.
 */
function correlateToolOutput(
  acc: RolloutAccumulator,
  callId: string | null,
  restrictToMcp: boolean
): OutputCorrelation {
  if (callId != null) {
    if (acc.completedCallIds.has(callId)) {
      return { kind: "duplicate" };
    }
    const idx = acc.toolCallIndex.get(callId);
    if (idx == null) {
      return { kind: "orphan" };
    }
    acc.completedCallIds.add(callId);
    return { kind: "by_call_id", tool: acc.toolUses[idx] };
  }
  // No id: documented positional compatibility fallback (legacy Codex data).
  const tool = restrictToMcp ? findLastOpenMcpTool(acc) : acc.toolUses.at(-1);
  return { kind: "ambiguous_fallback", tool };
}

/**
 * FEA-3701: the last MCP tool use whose output is not yet set — the positional
 * compatibility fallback for an identifier-free `mcp_tool_call_end`.
 */
function findLastOpenMcpTool(
  acc: RolloutAccumulator
): NormalizedToolUse | undefined {
  for (let i = acc.toolUses.length - 1; i >= 0; i--) {
    const tu = acc.toolUses[i];
    if (
      (tu.mcpServer != null || tu.mcpMethod != null) &&
      tu.output === undefined
    ) {
      return tu;
    }
  }
  return undefined;
}

const handleToolOutputItem: RolloutHandler = (acc, p, iso) => {
  const out = p.output ?? p.result ?? {};
  const outRec = asRecord(out);
  const isErr = outRec
    ? outRec.success === false || outRec.is_error === true || !!outRec.error
    : false;
  // FEA-3701: correlate the output to its call by call_id (interleave-safe),
  // falling back to positional matching only for legacy identifier-free data.
  const outputStr = typeof out === "string" ? out : JSON.stringify(out);
  const truncatedOutput = truncateText(outputStr);
  const outputCallId = readCallId(p);
  const correlation = correlateToolOutput(acc, outputCallId, false);
  if (correlation.kind === "orphan") {
    acc.orphanedToolOutputs++;
  } else if (correlation.kind === "ambiguous_fallback") {
    acc.ambiguousToolOutputs++;
  }
  const matchedTool =
    correlation.kind === "by_call_id"
      ? correlation.tool
      : correlation.kind === "ambiguous_fallback"
        ? correlation.tool
        : undefined;
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
  tool_search_call: handleToolSearchCallItem,
  local_shell_call: handleShellCallItem,
  function_call_output: handleToolOutputItem,
  custom_tool_call_output: handleToolOutputItem,
  local_shell_call_output: handleToolOutputItem,
};

/**
 * FEA-3715: the response_item `type`s this parser actually decodes (the live
 * `RESPONSE_ITEM_HANDLERS` keys). The protocol-inventory drift test cross-checks
 * this against the `decoded` coverage entries so a handler added/removed here
 * without a matching coverage edit fails CI.
 */
export const CODEX_DECODED_RESPONSE_ITEM_TYPES: readonly string[] =
  Object.freeze(Object.keys(RESPONSE_ITEM_HANDLERS));

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

/**
 * FEA-3525: capture the model's context-window size from a record that carries
 * `model_context_window` (latest valid value wins). Permissive: non-negative
 * integers only, never throws, does not touch token math. Shared by the
 * `token_count` and `task_started` event handlers — the SDK emits the window on
 * `token_count.info`, but zero-usage / aborted runs (0 token_count events) only
 * report it on `event_msg`/`task_started`, so both paths must contribute it.
 */
function captureModelContextWindow(acc: RolloutAccumulator, source: Rec): void {
  const contextWindow = asNonNegInt(source.model_context_window);
  if (contextWindow !== null) {
    acc.modelContextWindow = contextWindow;
  }
}

const handleTaskStartedEvent: RolloutHandler = (acc, p) => {
  captureModelContextWindow(acc, p);
};

/** Read a finite number field, returning null for anything else (NaN/±Inf too). */
function asFiniteNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * FEA-3524 / FEA-3702: narrow one `rate_limits` window (`primary`/`secondary`).
 * Never throws — a non-object, or fields of the wrong type, degrade to null
 * rather than aborting.
 *
 * Structural + semantic validation (FEA-3702, AC#1): a window is VALID only when
 * it is an object that carries at least one usable telemetry field
 * (`used_percent`, `window_minutes`, or `resets_at`). An object present but
 * carrying no usable fields (e.g. `{garbage:true}`) is an ALL-NULL window that
 * conveys no rate-limit state; treating it as valid would let a malformed partial
 * event replace a known-good sibling with nulls (the FEA-3702 data-loss bug).
 * Such a window is therefore rejected (`null`) so last-good is preserved.
 *
 * A window carrying a SUBSET of valid fields (a legitimate partial update — e.g.
 * Codex reporting `used_percent` with `resets_at` still pending) is accepted with
 * the absent/malformed fields left null; the caller merges it over last-good so
 * the surviving fields are not lost.
 *
 * Returns null (window absent OR all-null) so the caller preserves last-good.
 */
function readCodexRateLimitWindow(v: unknown): CodexRateLimitWindow | null {
  const w = asRecord(v);
  if (!w) {
    return null;
  }
  const window: CodexRateLimitWindow = {
    // Golden shape uses `used_percent`; tolerate `used_percentage` too.
    used_percent: asFiniteNum(w.used_percent) ?? asFiniteNum(w.used_percentage),
    window_minutes: asFiniteNum(w.window_minutes),
    resets_at: asFiniteNum(w.resets_at),
  };
  // Semantic gate: an object with no usable telemetry is not a valid window.
  if (
    window.used_percent === null &&
    window.window_minutes === null &&
    window.resets_at === null
  ) {
    return null;
  }
  return window;
}

/**
 * Outcome of reading the in-band `rate_limits` block off one `token_count`
 * event (FEA-3702). Discriminated so the caller distinguishes:
 *  - `"absent"`    — no block at all (or explicit `null`), OR a block whose
 *                    `primary`/`secondary` slots are themselves absent/explicitly
 *                    `null` (the legitimate no-active-window shape Codex stamps
 *                    for a plan with no per-window limit, e.g.
 *                    `{"limit_id":"premium","primary":null,"secondary":null}`).
 *                    Silently keep last-good, NOT a parse-quality signal (most
 *                    events legitimately carry `"rate_limits":null`).
 *  - `"valid"`     — at least one structurally + semantically valid window; the
 *                    windows are applied over last-good, preserving valid
 *                    siblings.
 *  - `"malformed"` — a block WAS present with at least one window slot carrying a
 *                    non-null value that produced no valid window (e.g.
 *                    `{primary:{garbage:true}}`, `{primary:{}}`,
 *                    `{secondary:12345}`), or a non-object block; last-good is
 *                    preserved AND the record is counted in parse quality (AC#4)
 *                    without failing the session.
 */
type CodexRateLimitsRead =
  | { kind: "absent" }
  | {
      kind: "valid";
      primary: CodexRateLimitWindow | null;
      secondary: CodexRateLimitWindow | null;
    }
  | { kind: "malformed" };

/**
 * FEA-3524 / FEA-3702: permissively read the in-band `rate_limits` block off a
 * `token_count` event. Never throws. See {@link CodexRateLimitsRead}.
 */
function readCodexRateLimits(info: Rec, p: Rec): CodexRateLimitsRead {
  const rawBlock = info.rate_limits ?? p.rate_limits;
  // Absent or explicit-null: the overwhelmingly common shape. Not a signal.
  if (rawBlock === undefined || rawBlock === null) {
    return { kind: "absent" };
  }
  const block = asRecord(rawBlock);
  // Present but not an object (e.g. a string/number) is a malformed record.
  if (!block) {
    return { kind: "malformed" };
  }
  const primary = readCodexRateLimitWindow(block.primary);
  const secondary = readCodexRateLimitWindow(block.secondary);
  if (primary || secondary) {
    return { kind: "valid", primary, secondary };
  }
  // Neither window yielded telemetry. Distinguish two shapes:
  //  - Both window SLOTS are themselves absent or explicitly `null` — the
  //    legitimate "no active window" block Codex stamps for plans with no
  //    per-window limit (e.g. `{"limit_id":"premium","primary":null,
  //    "secondary":null,...}`). This conveys no rate-limit state and is NOT a
  //    corruption signal: treat it like an absent block (keep last-good, no
  //    parse-quality signal), matching pre-FEA-3702 (FEA-3524) behavior.
  //  - At least one slot was PRESENT with a non-null value that failed to
  //    validate (e.g. `{primary:{garbage:true}}`, `{primary:{}}`,
  //    `{secondary:12345}`) — that IS a malformed record: preserve last-good
  //    AND count it (FEA-3702, AC#4).
  const primaryPresent = block.primary !== undefined && block.primary !== null;
  const secondaryPresent =
    block.secondary !== undefined && block.secondary !== null;
  if (primaryPresent || secondaryPresent) {
    return { kind: "malformed" };
  }
  return { kind: "absent" };
}

/**
 * Apply a validated `rate_limits` read over the accumulator's last-good snapshot
 * ATOMICALLY, preserving prior valid siblings (FEA-3702, AC#2). A valid `primary`
 * or `secondary` window replaces its slot; a window that was NOT valid on this
 * event (null) leaves the previously-captured sibling untouched rather than
 * blanking it — a partial update never zeroes the other window. Returns whether
 * the read counted as a malformed rate-limit record (AC#4).
 */
function applyCodexRateLimits(
  acc: RolloutAccumulator,
  read: CodexRateLimitsRead
): boolean {
  if (read.kind === "absent") {
    return false;
  }
  if (read.kind === "malformed") {
    return true;
  }
  const prev = acc.codexRateLimits;
  acc.codexRateLimits = {
    primary: read.primary ?? prev?.primary ?? null,
    secondary: read.secondary ?? prev?.secondary ?? null,
  };
  return false;
}

const handleTokenCountEvent: RolloutHandler = (acc, p, iso) => {
  const info = asRecord(p.info) ?? asRecord(p.token_count_info) ?? p;
  // FEA-3524 / FEA-3702: capture the in-band rate_limits snapshot. Independent of
  // the token-usage math below: valid windows are merged over last-good (a
  // partial update preserves its untouched sibling), an absent/null block is a
  // no-op, and a present-but-malformed block preserves last-good AND is counted
  // in parse quality without failing the session.
  if (applyCodexRateLimits(acc, readCodexRateLimits(info, p))) {
    acc.malformedRateLimits++;
  }
  const totals =
    asRecord(info.total_token_usage) ??
    asRecord(info.totalTokenUsage) ??
    asRecord(info.total);
  // FEA-1459 Fix 9: Skip codex-auto-review for session-level model. Done first
  // so the no-totals case still captures the model.
  const m = extractEventModel(acc, p, info);
  // FEA-3525: capture the model's context-window size. Read before the
  // no-totals return so an event carrying the window but no usage still
  // contributes it.
  captureModelContextWindow(acc, info);
  if (!totals) {
    return;
  }
  // CR-2: compute per-turn delta from cumulative totals.
  //
  // Graceful degradation (cloud-transcript render, non-Claude harnesses): a
  // single `token_count` event whose counters are fractional / negative /
  // JS-unsafe trips `readStorageTokenCount`'s `InvalidTokenCountError`. Newer or
  // non-canonical Codex/gpt-* rollouts have been seen carrying such values.
  // Aborting the whole rollout would blank the entire transcript (messages,
  // tools, timeline) over one bad usage snapshot — the same failure mode the
  // parser already tolerates for a malformed line (it drops that turn's usage
  // and continues). So drop THIS event's usage and keep parsing; the model was
  // already captured above, and the missing delta is a small token-total gap,
  // not a lost conversation.
  let current: CodexTokenTotals;
  try {
    current = readCodexTokenTotals(totals, "codex.current");
  } catch (error) {
    if (error instanceof InvalidTokenCountError) {
      // Drop this event's usage and keep the LAST-GOOD `previousTotals` as the
      // delta baseline (do NOT store the bad snapshot — the next event would
      // then re-read it via `computeTokenDeltas` and throw again). The next
      // valid snapshot's delta is computed against the last good baseline, so it
      // over-counts by at most this one dropped snapshot rather than aborting.
      return;
    }
    throw error;
  }
  const identity = codexUsageSnapshotIdentity(m ?? acc.model, current);
  if (acc.forkReplayMatching && acc.replayedUsageIdentities?.has(identity)) {
    acc.previousTotals = totals;
    return;
  }
  acc.forkReplayMatching = false;
  // FEA-3527: track the cumulative reasoning-output subdivision. `current` comes
  // from the cumulative `total_token_usage`, so the largest snapshot seen IS the
  // session total; take the max to stay monotonic against any out-of-order or
  // reset snapshot. This is metadata only — it is NOT added to any token total
  // (delta math below reads output verbatim and never touches reasoningOutput).
  //
  // Placed AFTER the fork-replay skip so a forked child does NOT absorb the
  // replayed parent-prefix reasoning: those snapshots are excluded from the
  // child's token-total deltas (return above), and the reasoning max must
  // mirror that dedup or `root.reasoning + child.reasoning` double-counts the
  // parent's portion.
  if (current.reasoningOutput > acc.reasoningOutputTokens) {
    acc.reasoningOutputTokens = current.reasoningOutput;
  }
  // FEA-3125: assistantMessages = billable API round-trips (token_count events
  // with extractable totals, excluding fork-replay entries).
  acc.assistantMessageCount++;
  // FEA-3608: record this round-trip's effective timestamp so
  // rebaseReplayedBurst can decrement by burst EVENTS, not removed tokenSeries
  // entries. `iso` here is the event's own timestamp or the carried last-seen
  // one (parse loop: `explicitIso || acc.lastTs`), so a zero-delta or deferred
  // burst event — which bumps the count above but pushes no tokenSeries entry
  // below — still gets a window-comparable timestamp aligned with this count++.
  acc.tokenEventTimestamps.push(iso);
  // FEA-3682: record this event's cumulative reasoning snapshot, index-aligned
  // with `tokenEventTimestamps`, so `rebaseReplayedBurst` can rebase reasoning
  // by the same leading-burst boundary that rebases the output total.
  acc.reasoningOutputSnapshots.push(current.reasoningOutput);
  const delta = computeTokenDeltas(current, acc.previousTotals);
  acc.previousTotals = totals;

  // FEA-2085: no extractable per-event or session model → priceable
  // fallback, flagged as an inferred (guessed) attribution.
  const eventInferred = !(m ?? acc.model);
  const eventModel = m ?? acc.model ?? CODEX_FALLBACK_MODEL;

  // FEA-3526: capture the authoritative per-turn `last_token_usage` snapshot as
  // metadata and reconcile it against the cumulative-derived `delta`. Never
  // feeds token totals; a malformed/absent snapshot is simply dropped.
  const lastSnapshot = readCodexLastTokenSnapshot(info, eventModel, iso, delta);
  if (lastSnapshot) {
    acc.codexLastTokenUsage.push(lastSnapshot);
  }

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
    // CR-6: preserve MCP server and method from the event payload. Modern Codex
    // nests them under `invocation`; older shapes carry them at top level.
    const invocation = asRecord(p.invocation);
    const server =
      asStr(p.server) ??
      asStr(p.mcp_server) ??
      (invocation ? asStr(invocation.server) : null) ??
      undefined;
    const method =
      asStr(p.method) ??
      asStr(p.tool) ??
      asStr(p.tool_name) ??
      (invocation ? asStr(invocation.tool) : null) ??
      undefined;
    const displayName =
      server && method
        ? `${server}__${method}`
        : (method ?? server ?? "mcp_tool");
    acc.toolUses.push({
      name: displayName,
      timestamp: iso || acc.firstTimestamp,
      input:
        p.arguments ??
        p.input ??
        (invocation ? invocation.arguments : null) ??
        null,
      mcpServer: server,
      mcpMethod: method,
    });
    // FEA-3701: index this MCP call by its call_id so the paired
    // `mcp_tool_call_end` correlates to THIS call — not to whichever MCP call
    // happens to be last when calls interleave (A-begin, B-begin, A-end, B-end).
    const beginCallId = readCallId(p);
    if (beginCallId) {
      acc.toolCallIndex.set(beginCallId, acc.toolUses.length - 1);
    }
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

/**
 * FEA-3701: True when a tool use is one this MCP-end path is allowed to write —
 * i.e. an MCP call synthesized by the `mcp_tool_call_begin` fallback (it carries
 * `mcpServer`/`mcpMethod`). Modern rollouts model the MCP call as a
 * `function_call` response item instead (no `mcpServer`), and its authoritative
 * output arrives as a `function_call_output` response item; the `mcp_tool_call_end`
 * is then a redundant echo that must NOT overwrite the response-item output or
 * consume its call id. Gating on MCP-synthesized tools keeps those sessions
 * byte-identical while still fixing interleaved correlation in event-only logs.
 */
function isMcpSynthesizedTool(tool: NormalizedToolUse): boolean {
  return tool.mcpServer != null || tool.mcpMethod != null;
}

const handleMcpToolCallEndEvent: RolloutHandler = (acc, p, iso) => {
  const out = p.output ?? p.result ?? undefined;
  const outRec = asRecord(out);
  const isErr = outRec
    ? outRec.success === false || outRec.is_error === true || !!outRec.error
    : false;
  // FEA-3701: correlate the completion to its ORIGINATING MCP call by call_id
  // (interleave-safe), falling back to the last open MCP call only for legacy
  // identifier-free events. The old code always backward-scanned for the last
  // open MCP tool, so under A-begin, B-begin, A-end, B-end it attached A's
  // output to B (whichever was scanned first) — a cross-assignment the call_id
  // key eliminates.
  const endCallId = readCallId(p);
  const correlation = correlateToolOutput(acc, endCallId, true);
  if (correlation.kind === "by_call_id") {
    // Only write MCP-synthesized tools. A call_id that resolves to a
    // response-item tool means the authoritative `function_call_output` owns the
    // output; roll back the completion mark so that output still applies.
    if (isMcpSynthesizedTool(correlation.tool)) {
      if (out !== undefined && correlation.tool.output === undefined) {
        const outputStr = typeof out === "string" ? out : JSON.stringify(out);
        correlation.tool.output = truncateText(outputStr);
        correlation.tool.isError = isErr;
      }
    } else if (endCallId != null) {
      acc.completedCallIds.delete(endCallId);
    }
  } else if (correlation.kind === "orphan") {
    acc.orphanedToolOutputs++;
  } else if (correlation.kind === "ambiguous_fallback") {
    acc.ambiguousToolOutputs++;
    if (correlation.tool && out !== undefined) {
      const outputStr = typeof out === "string" ? out : JSON.stringify(out);
      correlation.tool.output = truncateText(outputStr);
      correlation.tool.isError = isErr;
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

/**
 * FEA-3127: a top-level `compacted` record (payload carries the
 * replacement_history) marks a context compaction. It classifies as an
 * event-like record (bare `type` fallback in classify), so it dispatches here
 * with the FULL record as `p` and its own timestamp as `iso`. Record the
 * compaction and note that its `context_compacted` echo is still pending.
 */
const handleCompactedRecord: RolloutHandler = (acc, _p, iso) => {
  acc.compactions.push({ uuid: null, timestamp: iso });
  acc.pendingCompactedEchoes++;
};

/**
 * FEA-3127: the `event_msg`/`context_compacted` echo of a `compacted` record.
 * Consume a pending `compacted` signal when one exists (the pair is ONE
 * compaction — the `compacted` record's timestamp is authoritative);
 * otherwise this rollout shape only emits the event, so record it.
 */
const handleContextCompactedEvent: RolloutHandler = (acc, _p, iso) => {
  if (acc.pendingCompactedEchoes > 0) {
    acc.pendingCompactedEchoes--;
    return;
  }
  acc.compactions.push({ uuid: null, timestamp: iso });
};

const EVENT_HANDLERS: Record<string, RolloutHandler> = {
  item_completed: handleItemCompletedEvent,
  user_message: handleUserMessageEvent,
  agent_message: handleAgentMessageEvent,
  agent_message_delta: handleAgentMessageEvent,
  agent_reasoning: handleAgentReasoningEvent,
  agent_reasoning_section_break: handleAgentReasoningEvent,
  token_count: handleTokenCountEvent,
  task_started: handleTaskStartedEvent,
  compacted: handleCompactedRecord,
  context_compacted: handleContextCompactedEvent,
  error: handleErrorEvent,
  stream_error: handleErrorEvent,
  exec_command_begin: handleToolBeginFallbackEvent,
  patch_apply_begin: handleToolBeginFallbackEvent,
  mcp_tool_call_begin: handleToolBeginFallbackEvent,
  mcp_tool_call_end: handleMcpToolCallEndEvent,
};

/**
 * FEA-3715: the event_msg `type`s this parser actually decodes (the live
 * `EVENT_HANDLERS` keys). The protocol-inventory drift test cross-checks this
 * against the `decoded` coverage entries so a handler added/removed here without
 * a matching coverage edit fails CI.
 */
export const CODEX_DECODED_EVENT_MSG_TYPES: readonly string[] = Object.freeze(
  Object.keys(EVENT_HANDLERS)
);

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

/**
 * FEA-3708: the parent-thread id of a Codex subagent-spawn rollout, mirroring
 * the collector's `extractParentThreadId` (codex-subagent-rollouts.ts). A
 * spawned subagent's `session_meta.forked_from_id` equals this value — it is the
 * spawn link (captured separately as the subagent's parentId), NOT a fork — so
 * the fork-lineage capture below skips it, matching `buildCodexChildMeta`, which
 * records `codexForkedFromId` only when there is no parent thread.
 */
function codexParentThreadId(p: Rec): string | null {
  const threadSpawn = asRecord(
    asRecord(asRecord(p.source)?.subagent)?.thread_spawn
  );
  return asStr(threadSpawn?.parent_thread_id) ?? asStr(p.parent_thread_id);
}

/** Apply a session_meta record's metadata fields (first non-null wins). */
function applySessionMeta(acc: RolloutAccumulator, p: Rec): void {
  if (!acc.cwd) {
    const candidate = asStr(p.cwd) ?? asStr(p.workdir);
    if (isMeaningfulCwd(candidate)) {
      acc.cwd = candidate;
    }
  }
  // FEA-2641: launch-mode discriminator (see RolloutAccumulator.originator).
  if (!acc.originator && p.originator) {
    acc.originator = asStr(p.originator);
  }
  // FEA-3708: parent-rollout lineage pointer (a forked/resumed rollout's
  // session_meta names the rollout it replays history from). First non-null
  // wins; an empty string is treated as absent. A subagent-spawn rollout is
  // skipped — its forked_from_id merely mirrors parent_thread_id (the spawn
  // link), not a fork (see codexParentThreadId), matching buildCodexChildMeta.
  if (!acc.forkedFromId) {
    const forkedFrom = asStr(p.forked_from_id);
    if (forkedFrom && !codexParentThreadId(p)) {
      acc.forkedFromId = forkedFrom;
    }
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
  if (!acc.cwd) {
    const candidate = asStr(p.cwd);
    if (isMeaningfulCwd(candidate)) {
      acc.cwd = candidate;
    }
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
  // FEA-3681: return early only when NEITHER the rebased `tokenSeries` NOR the
  // parallel `tokenEventTimestamps` has a burst-window entry. A FULLY zero-delta
  // replayed burst bumps `assistantMessageCount` and records a
  // `tokenEventTimestamps` entry for every event but pushes NO `tokenSeries`
  // entry (delta zero → `iso && hasTokens` false at the count site; see the
  // FEA-3608 explanation on the decrement below). Gating on `tokenSeries` alone
  // let that case skip the decrement below, leaving `assistantMessages`/`turns`
  // inflated by the replayed round-trips even though the token totals were
  // rebased — the exact under-count FEA-3608 fixed for the partial-zero case.
  // Keep BOTH disjuncts: the `tokenSeries` term still guards the FEA-2343
  // deferred-flush entry pushed just above (timestamped, but with no matching
  // `tokenEventTimestamps` push), so neither disjunct fully subsumes the other.
  if (
    !(
      acc.tokenSeries.some((e) => inLeadingBurst(e.timestamp)) ||
      acc.tokenEventTimestamps.some((ts) => inLeadingBurst(ts))
    )
  ) {
    return;
  }
  let writeIdx = 0;
  for (const e of acc.tokenSeries) {
    if (!inLeadingBurst(e.timestamp)) {
      acc.tokenSeries[writeIdx++] = e;
    }
  }
  acc.tokenSeries.length = writeIdx;
  // FEA-3608: decrement assistantMessages by the number of burst `token_count`
  // EVENTS, not the number of removed `tokenSeries` entries. FEA-3439 used the
  // removed-entry count, which UNDER-counts whenever a replayed burst event had
  // a zero delta (cumulative unchanged) or no own timestamp: `assistantMessageCount++`
  // runs for EVERY extractable `token_count` event, but `tokenSeries.push` runs
  // only when `iso && hasTokens`, so such an event bumps the count with no
  // matching entry to remove. Counting the per-event timestamps recorded at the
  // count site restores the exact FEA-3125/FEA-3439 `turns` (userMessages +
  // assistantMessages) vs rebased-token alignment. Filter the parallel array by
  // the same `inLeadingBurst` predicate so it stays in sync with the surviving
  // round-trips.
  // FEA-3682: rebase `reasoningOutputTokens` in lockstep with the token-event
  // filtering below. It is a whole-file cumulative MAX, so without this the
  // replayed burst's parent reasoning survives while the output total is rebased
  // to a burst-relative delta — the surfaced `reasoning_output_tokens` could
  // then exceed the session's own output (breaking the FEA-3527 subset
  // invariant) and double-count the parent's reasoning across resumed sessions.
  // Re-derive it as (max surviving cumulative reasoning − max burst cumulative
  // reasoning), the reasoning analogue of the output delta rebase: the burst
  // supplies the baseline the surviving portion is measured against, just as the
  // first surviving output delta is computed against the last burst snapshot.
  // Reasoning is tracked as a cumulative MAX (mirroring the max at the capture
  // site above) rather than last-wins so an out-of-order or reset snapshot can't
  // deflate the baseline — for the monotonic cumulative snapshots a replay
  // produces, the max IS the last, and choosing the max keeps the rebased value
  // an underestimate-safe subset of output (a larger baseline can only shrink
  // it). `reasoningOutputSnapshots` is index-aligned with `tokenEventTimestamps`,
  // so both are filtered together.
  let tokenEventWriteIdx = 0;
  let burstTokenEventCount = 0;
  let burstReasoningBaseline = 0;
  let survivingReasoningMax = 0;
  for (let i = 0; i < acc.tokenEventTimestamps.length; i++) {
    const ts = acc.tokenEventTimestamps[i];
    const reasoning = acc.reasoningOutputSnapshots[i] ?? 0;
    if (inLeadingBurst(ts)) {
      burstTokenEventCount++;
      if (reasoning > burstReasoningBaseline) {
        burstReasoningBaseline = reasoning;
      }
    } else {
      if (reasoning > survivingReasoningMax) {
        survivingReasoningMax = reasoning;
      }
      acc.reasoningOutputSnapshots[tokenEventWriteIdx] = reasoning;
      acc.tokenEventTimestamps[tokenEventWriteIdx] = ts;
      tokenEventWriteIdx++;
    }
  }
  acc.tokenEventTimestamps.length = tokenEventWriteIdx;
  acc.reasoningOutputSnapshots.length = tokenEventWriteIdx;
  acc.assistantMessageCount -= burstTokenEventCount;
  acc.reasoningOutputTokens = Math.max(
    0,
    survivingReasoningMax - burstReasoningBaseline
  );
  // FEA-3526: the per-turn `last_token_usage` snapshots are pushed from the same
  // `token_count` events as `tokenSeries`, so a replayed leading burst re-imports
  // them too. Drop the burst snapshots by the SAME `inLeadingBurst` predicate to
  // keep the two arrays' event membership in sync — otherwise the metadata would
  // carry duplicate replayed snapshots the canonical (rebased) token totals no
  // longer count.
  let snapshotWriteIdx = 0;
  for (const s of acc.codexLastTokenUsage) {
    if (!inLeadingBurst(s.timestamp)) {
      acc.codexLastTokenUsage[snapshotWriteIdx++] = s;
    }
  }
  acc.codexLastTokenUsage.length = snapshotWriteIdx;
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
  // FEA-3713: count valid-JSON records the classifier cannot route to any
  // handler (`kind:"other"` — the `dispatchLine` default that silently drops the
  // record). A record the parser doesn't understand was previously ignored
  // without lowering any parse-quality signal; tracking it surfaces the loss.
  let unknownRecords = 0;

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
    if (c.kind === "other") {
      unknownRecords++;
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
    compactions: acc.compactions, // FEA-3127
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
    // FEA-3526: authoritative per-turn `last_token_usage` snapshots (metadata;
    // omitted when the rollout emitted no token_count events).
    ...(acc.codexLastTokenUsage.length > 0
      ? { codexLastTokenUsage: acc.codexLastTokenUsage }
      : {}),
    diffStats: acc.diffStats, // CR-4
    // FEA-3527: surface the cumulative reasoning-output subdivision as metadata.
    // A SUBSET of the output total already counted in tokenSeries/tokensByModel —
    // never additive. Other usageExtras fields keep their empty defaults.
    usageExtras: {
      ...emptyUsageExtras(),
      reasoning_output_tokens: acc.reasoningOutputTokens,
    },
    artifacts, // CR-13
    // FEA-2907: parse-quality signal (malformed-line drops, truncated final line)
    // at parity with the Claude parser (FEA-2771).
    // FEA-3702: `malformedRateLimits` counts present-but-malformed `rate_limits`
    // blocks whose last-good snapshot was preserved. Stamped only when nonzero so
    // clean sessions omit it and round-trip unchanged (no golden snapshot churn).
    // FEA-3713 adds unknownRecords, emitted only when non-zero so clean rollouts
    // round-trip byte-identically (no golden-snapshot churn) — the Claude core
    // omits the field entirely.
    // FEA-3701: the MCP/tool-output correlation diagnostics are additive and are
    // OMITTED when zero, so a clean session round-trips byte-identical to its
    // frozen normalized.json (only genuinely orphaned/ambiguous records surface).
    parseQuality: {
      totalLines,
      malformedLines,
      truncatedFinalLine: lastLineMalformed,
      ...(acc.malformedRateLimits > 0
        ? { malformedRateLimits: acc.malformedRateLimits }
        : {}),
      ...(unknownRecords > 0 ? { unknownRecords } : {}),
      ...(acc.orphanedToolOutputs > 0
        ? { orphanedToolOutputs: acc.orphanedToolOutputs }
        : {}),
      ...(acc.ambiguousToolOutputs > 0
        ? { ambiguousToolOutputs: acc.ambiguousToolOutputs }
        : {}),
    },
    // FEA-3525: only set when Codex reported it, so rollouts without a
    // model_context_window omit the field and round-trip unchanged.
    ...(acc.modelContextWindow === null
      ? {}
      : { modelContextWindow: acc.modelContextWindow }),
    // FEA-3524: only stamp the field when a well-formed rate_limits block was
    // seen, so rate_limits-null sessions omit it and pre-existing payloads
    // round-trip unchanged.
    ...(acc.codexRateLimits ? { codexRateLimits: acc.codexRateLimits } : {}),
    // FEA-3708: only stamp the parent-rollout lineage pointer when the rollout
    // was forked/resumed (session_meta.forked_from_id present), so a root
    // session and every non-Codex payload omit it and round-trip unchanged.
    ...(acc.forkedFromId ? { codexForkedFromId: acc.forkedFromId } : {}),
    // FEA-3715: record the reviewed Codex protocol pin the parser decoded this
    // rollout under, so every Codex session self-documents the supported
    // version/commit range. Static metadata — it never feeds token math, is
    // stripped before the Layer-1 golden deep-equal (the signed oracles
    // predate it), and is intentionally NOT persisted to the DB metadata blob
    // (it would drift every Codex session's snapshot for no per-session signal).
    codexProtocolSupport: CODEX_PROTOCOL_SUPPORT,
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
    // Mirror `handleTokenCountEvent`'s invalid-counter tolerance: a parent
    // rollout carrying a fractional / negative / JS-unsafe cumulative counter
    // must not throw here and abort the whole fork/replay dedup (which would
    // blank a forked descendant's import). Drop this snapshot's identity and
    // keep collecting — a missing identity only weakens dedup for that one
    // snapshot, it does not corrupt the child parse.
    let snapshot: CodexTokenTotals;
    try {
      snapshot = readCodexTokenTotals(totals, "codex.identity");
    } catch (error) {
      if (error instanceof InvalidTokenCountError) {
        continue;
      }
      throw error;
    }
    identities.add(codexUsageSnapshotIdentity(eventModel, snapshot));
  }
  return identities;
}

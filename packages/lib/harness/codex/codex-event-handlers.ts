/**
 * @file codex-event-handlers.ts
 * @description The `event_msg` handlers and their `type`-keyed registry —
 * including the `token_count` handler that owns Codex's cumulative token
 * bookkeeping, rate-limit reading, and the identifier-free tool-begin fallback.
 *
 * Split out of `parse-codex.ts` for ISS-7623 (pure code motion, no behavior
 * change), mirroring the per-record-kind handler modules of the Claude parser.
 */

import { estimateAgentComponentFootprintTokens } from "@repo/api/src/types/agent-component-footprint";
import { pushTurnDuration, truncateText } from "../parser-utils";
import { InvalidTokenCountError } from "../token-counts";
import { recordToolResultFacts } from "../tool-result-facts";
import { asRecord } from "../type-guards";
import type { CodexRateLimitWindow, NormalizedToolUse } from "../types";
import {
  asNonNegInt,
  asStr,
  CODEX_FALLBACK_MODEL,
  type Rec,
  type RolloutAccumulator,
  type RolloutHandler,
  readCallId,
} from "./codex-accumulator";
import { mergeDiffDelta } from "./codex-diff-stats";
import {
  MCP_TOOL_CALL_ITEM_TYPE,
  recordMcpToolCallItem,
} from "./codex-mcp-tool-call-item";
import {
  dropPendingUsage,
  recordTokenUsageRecord,
  takeUsageIdentity,
} from "./codex-request-binding";
import { correlateToolOutput } from "./codex-response-item-handlers";
import { CODEX_AUTO_REVIEW_LABEL } from "./codex-session-meta";
import {
  type CodexTokenTotals,
  codexUsageSnapshotIdentity,
  computeTokenDeltas,
  readCodexLastTokenSnapshot,
  readCodexTokenTotals,
} from "./codex-token-usage";
import {
  recordUserMessageItem,
  USER_MESSAGE_ITEM_TYPE,
} from "./codex-user-message-item";

// ── event_msg handlers ──────────────────────────────────────────────────────
// Each handles one Codex event type, sharing the mutable accumulator.

const handleItemCompletedEvent: RolloutHandler = (acc, p, iso) => {
  // CLOSEDLOOP plan-extraction (FEA-1189): the strongest Codex plan signal —
  // a structured item_completed event carrying item.type === "Plan".
  const item = asRecord(p.item);
  if (acc.attributionEvidence && item?.type === MCP_TOOL_CALL_ITEM_TYPE) {
    recordMcpToolCallItem(acc, item, p, iso);
    return;
  }
  if (acc.attributionEvidence && item?.type === USER_MESSAGE_ITEM_TYPE) {
    recordUserMessageItem(acc, item);
    return;
  }
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
    dropPendingUsage(acc);
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
    const sourceIdentity = takeUsageIdentity(acc);
    acc.tokenSeries.push({
      timestamp: iso,
      model: eventModel,
      input: delta.input + (deferred?.input ?? 0),
      output: delta.output + (deferred?.output ?? 0),
      cacheRead: delta.cacheRead + (deferred?.cacheRead ?? 0),
      cacheWrite: delta.cacheWrite + (deferred?.cacheWrite ?? 0),
      ...(eventInferred ? { inferred: true } : {}),
      ...(sourceIdentity ? { sourceIdentity } : {}),
    });
  } else if (!hasTokens) {
    dropPendingUsage(acc);
  }
};

/** ISS-12552: a request's own usage record, naming its response id. */
const handleTokenUsageRecord: RolloutHandler = (acc, p) => {
  if (acc.attributionEvidence) {
    recordTokenUsageRecord(acc, p);
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
        if (acc.attributionEvidence) {
          recordToolResultFacts(correlation.tool, outputStr, isErr);
        }
        correlation.tool.output = truncateText(outputStr);
        correlation.tool.isError = isErr;
        // ISS-10736: counted before the cap, as the Claude and Cursor lanes do.
        correlation.tool.outputFootprintTokens =
          estimateAgentComponentFootprintTokens(outputStr);
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
      if (acc.attributionEvidence) {
        recordToolResultFacts(correlation.tool, outputStr, isErr);
      }
      correlation.tool.output = truncateText(outputStr);
      correlation.tool.isError = isErr;
      // ISS-10736: counted before the cap, as the Claude and Cursor lanes do.
      correlation.tool.outputFootprintTokens =
        estimateAgentComponentFootprintTokens(outputStr);
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

const EVENT_HANDLERS = new Map<string, RolloutHandler>([
  ["item_completed", handleItemCompletedEvent],
  ["user_message", handleUserMessageEvent],
  ["agent_message", handleAgentMessageEvent],
  ["agent_message_delta", handleAgentMessageEvent],
  ["agent_reasoning", handleAgentReasoningEvent],
  ["agent_reasoning_section_break", handleAgentReasoningEvent],
  ["token_count", handleTokenCountEvent],
  ["token_usage_record", handleTokenUsageRecord],
  ["task_started", handleTaskStartedEvent],
  ["compacted", handleCompactedRecord],
  ["context_compacted", handleContextCompactedEvent],
  ["error", handleErrorEvent],
  ["stream_error", handleErrorEvent],
  ["exec_command_begin", handleToolBeginFallbackEvent],
  ["patch_apply_begin", handleToolBeginFallbackEvent],
  ["mcp_tool_call_begin", handleToolBeginFallbackEvent],
  ["mcp_tool_call_end", handleMcpToolCallEndEvent],
]);

/**
 * FEA-3715: the event_msg `type`s this parser actually decodes (the live
 * `EVENT_HANDLERS` keys). The protocol-inventory drift test cross-checks this
 * against the `decoded` coverage entries so a handler added/removed here without
 * a matching coverage edit fails CI.
 */
export const CODEX_DECODED_EVENT_MSG_TYPES: readonly string[] = Object.freeze([
  ...EVENT_HANDLERS.keys(),
]);

/** Dispatch an event_msg payload by its `type` to the shared registry. */
export function dispatchEvent(
  acc: RolloutAccumulator,
  p: Rec,
  iso: string | null,
  explicitIso: string | null
): void {
  const et = asStr(p.type);
  if (!et) {
    return;
  }
  EVENT_HANDLERS.get(et)?.(acc, p, iso, explicitIso);
}

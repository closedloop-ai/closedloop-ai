/**
 * @file codex-response-item-handlers.ts
 * @description The Responses-API `response_item` handlers, their `type`-keyed
 * registry, and the tool-output correlation the `mcp_tool_call_end` event
 * handler shares.
 *
 * Split out of `parse-codex.ts` for ISS-7623 (pure code motion, no behavior
 * change), mirroring the per-record-kind handler modules of the Claude parser.
 */

import { estimateAgentComponentFootprintTokens } from "@repo/api/src/types/agent-component-footprint";
import {
  isSyntheticModelKey,
  pushTurnDuration,
  safeJson,
  truncateText,
} from "../parser-utils";
import { recordToolResultFacts } from "../tool-result-facts";
import { asRecord } from "../type-guards";
import type { NormalizedMessage, NormalizedToolUse } from "../types";
import {
  asStr,
  extractText,
  type Rec,
  type RolloutAccumulator,
  type RolloutHandler,
  readCallId,
} from "./codex-accumulator";
import { mergeDiffDelta } from "./codex-diff-stats";
import { awaitRequest } from "./codex-request-binding";

// CLOSEDLOOP plan-extraction (FEA-1189): Codex emits implementation plans as a
// structured `item_completed` event whose item.type === "Plan", and (fallback)
// as a <proposed_plan> block inside an assistant message. We surface both into
// session.plans[]; plan-extractor/plan-store handle normalization + versioning.
const PROPOSED_PLAN_RE = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/i;

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
  const namespace = acc.attributionEvidence ? asStr(p.namespace) : null;
  const tu: NormalizedToolUse = {
    name: toolName,
    timestamp: iso || acc.firstTimestamp,
    input: toolInput,
    // ISS-12552: an MCP call made as a namespaced function call. Its call id is
    // the id the harness sends the MCP server, so it joins a receipt.
    ...(namespace ? { mcpNamespace: namespace } : {}),
    ...(namespace && callId ? { providerToolUseId: callId } : {}),
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
  awaitRequest(acc, tu);
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
  awaitRequest(acc, shellTu);
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
export function correlateToolOutput(
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
  // ISS-10736 (tamsinb + whitlockk review): read the presence separately from the
  // `{}` default below. That default exists so `isErr` has a record to probe,
  // and counting it would publish ~1 token for a call that returned NOTHING —
  // `outputFootprintTokens` is documented absent when the parser saw no result,
  // which is a different fact from a result that was empty.
  const sawResult = (p.output ?? p.result) !== undefined;
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
    if (sawResult && acc.attributionEvidence) {
      recordToolResultFacts(matchedTool, outputStr, isErr);
    }
    matchedTool.output = truncatedOutput;
    matchedTool.isError = isErr;
    // Counted over `outputStr`, above the 4 KiB cap `truncatedOutput` takes —
    // the count cannot be recovered downstream from a byte-capped prefix.
    if (sawResult) {
      matchedTool.outputFootprintTokens =
        estimateAgentComponentFootprintTokens(outputStr);
    }
  }
  if (isErr) {
    const content =
      typeof out === "string"
        ? out.slice(0, 500)
        : JSON.stringify(out).slice(0, 500);
    acc.toolResultErrors.push({ content, timestamp: iso });
  }
};

const RESPONSE_ITEM_HANDLERS = new Map<string, RolloutHandler>([
  ["message", handleMessageItem],
  ["reasoning", handleReasoningItem],
  ["function_call", handleToolCallItem],
  ["custom_tool_call", handleToolCallItem],
  ["tool_search_call", handleToolSearchCallItem],
  ["local_shell_call", handleShellCallItem],
  ["function_call_output", handleToolOutputItem],
  ["custom_tool_call_output", handleToolOutputItem],
  ["local_shell_call_output", handleToolOutputItem],
]);

/**
 * FEA-3715: the response_item `type`s this parser actually decodes (the live
 * `RESPONSE_ITEM_HANDLERS` keys). The protocol-inventory drift test cross-checks
 * this against the `decoded` coverage entries so a handler added/removed here
 * without a matching coverage edit fails CI.
 */
export const CODEX_DECODED_RESPONSE_ITEM_TYPES: readonly string[] =
  Object.freeze([...RESPONSE_ITEM_HANDLERS.keys()]);

/** Dispatch a response_item payload by its `type` to the shared registry. */
export function dispatchResponseItem(
  acc: RolloutAccumulator,
  p: Rec,
  iso: string | null,
  explicitIso: string | null
): void {
  acc.sawResponseItems = true;
  RESPONSE_ITEM_HANDLERS.get(asStr(p.type) ?? "")?.(acc, p, iso, explicitIso);
}

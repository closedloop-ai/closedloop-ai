/**
 * @file subagent-scanner.ts
 * @description Live-hook subagent JSONL scanner (Gap 6). When triggered (by
 * SubagentStop or periodic check), reads the subagent's own transcript file
 * and creates per-subagent tool-call events attributed to the correct subagent
 * agent_id. This enables per-subagent cost breakdowns and tool-usage heatmaps
 * in the live-hook path, matching the boot importer's behavior.
 */

import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import { estimateAgentComponentFootprintTokens } from "@repo/api/src/types/agent-component-footprint";
import { isReplayedTranscriptEntry } from "@repo/lib/harness/claude/replayed-entry";
import { toIso, toolResultText } from "@repo/lib/harness/parser-utils";
import { requestKeyFor } from "@repo/lib/harness/request-key";
import {
  readUntypedToolResultFacts,
  type UntypedToolResultFacts,
} from "@repo/lib/harness/tool-result-facts";
import { claudeTranscriptEntryUuidScheme } from "@repo/lib/harness/usage-dedup";
import { asRecord } from "../../../shared/type-guards.js";
import {
  MAX_STRINGIFIED_CHARS,
  stringifyBoundedJsonString,
  stringifyBoundedResult,
} from "./subagent-tool-serialization.js";

export type SubagentToolUseRecord = {
  agentId: string;
  sessionId: string;
  /** Native Claude tool_use block id; preserves identity for same-ms events. */
  toolUseId: string | null;
  /** ISS-12552: the request that issued the call (`requestKeyFor`). */
  requestKey: string | null;
  toolName: string;
  timestamp: string | null;
  /**
   * ISS-6480: `input` is the RAW value, not a bounded string. It was stored
   * through `stringifyBounded` and re-parsed by the reader; past the bound the
   * slice landed mid-token, `JSON.parse` threw, and the input was dropped
   * ENTIRELY — the bound yielded nothing, never a preview.
   *
   * `null` is the ABSENT sentinel here. Known limitation, tracked as ISS-7161:
   * a tool input that genuinely was `null` is stored the same way, so the two
   * are currently indistinguishable. A falsy-but-real `0`, `""`, or `false` is
   * preserved on both readers.
   *
   * `output` deliberately keeps its bound: revision 82 made it valid JSON inside
   * that bound, so an over-bound result is truncated rather than lost.
   */
  input: unknown;
  output: string | null;
  /**
   * ISS-10736 (tamsinb review): the context footprint of the FULL result, taken
   * HERE because `output` above is bound-capped and a count over a capped prefix
   * under-states the real injection systematically rather than sampling it.
   *
   * Without this every tool call a Claude subagent made reached the row writer
   * with no footprint at all — the sidecar lane never passes through the main
   * transcript's `parse-claude-user` counter — so a large share of `tool` rows
   * stayed NULL while the main-transcript ones filled. `null` is absent.
   */
  outputFootprintTokens: number | null;
  /**
   * ISS-12552: result facts read from the FULL result, before `output` was
   * bounded. `null` is absent.
   */
  resultFacts: UntypedToolResultFacts | null;
  resultTimestamp: string | null;
  isError: boolean | null;
};

export type SubagentScanResult = {
  toolUses: SubagentToolUseRecord[];
  /** Native ids removed because this file contained contradictory evidence. */
  conflictedToolUseIds: string[];
};

export type SubagentToolUseAccumulator = {
  actionsById: Map<string, AccumulatedToolUse>;
  resultsById: Map<string, AccumulatedToolResult>;
  unkeyedActions: AccumulatedToolUse[];
  conflictedIds: Set<string>;
  sequence: number;
  sessionId: string;
  subagentId: string;
};

type AccumulatedToolUse = SubagentToolUseRecord & { sequence: number };

type AccumulatedToolResult = {
  output: string;
  outputFootprintTokens: number | null;
  resultFacts: UntypedToolResultFacts | null;
  resultTimestamp: string | null;
  isError: boolean | null;
};

function normalizeTimestamp(raw: unknown): string {
  return toIso(raw) ?? "";
}

/**
 * Read a subagent JSONL transcript file and extract tool_use blocks, streaming
 * it a line at a time. Returns the list of tool-use records suitable for
 * insertion as PostToolUse events on the subagent's agent_id.
 *
 * The subagent transcript path convention follows Claude Code's output
 * directory layout: <parentTranscriptDir>/<sessionId>/subagents/agent-*.jsonl.
 * The caller resolves the native `agent-*` id from persisted agent metadata.
 *
 * ISS-6899: this is the SOLE whole-file entry point. A synchronous twin used to
 * sit above it, carrying its own copy of the replayed-entry filter below and
 * `readFileSync`ing an entire transcript on the main process thread. It had no
 * production callers, so it was drift surface kept in step with this function
 * for no gain, and it is gone.
 *
 * ISS-5426 (whitlockk review, PR #4715): resume/compaction REPLAYS are dropped by
 * `uuid` (FEA-3453) before extraction. A caller-side `tool_use.id` dedup cannot
 * stand in for that filter — `tool_use.id` is raw transcript JSON and may be
 * absent, so an IDLESS replayed tool use would be merged twice and ride on into
 * every downstream projection (the skills derivation, the per-subagent tool
 * events, the tool heatmaps). The filter lives here rather than at the call site
 * so the guard cannot be forgotten by a future caller. Scoped per CALL, matching
 * the per-file scoping of the parser's set.
 *
 * ISS-5542: the boot importer no longer calls this. `claude-parser.ts` already
 * streams every sidecar once — through `readAgentFile` since the ISS-6531
 * rewrite deleted `collectEntriesFromFile` — and folds {@link extractToolUses}
 * into that pass rather than re-opening and re-parsing the same file here. The
 * live-hook path (`database/live-hook.ts`), which has no such pass of its own,
 * is this function's remaining caller. The two readers must move TOGETHER: they
 * read the same files and any divergence makes one lane see tools the other
 * does not (ISS-6576).
 */
export async function scanSubagentTranscriptStream(
  filePath: string,
  sessionId: string,
  subagentId: string
): Promise<SubagentScanResult> {
  try {
    statSync(filePath);
  } catch {
    return { toolUses: [], conflictedToolUseIds: [] };
  }

  const accumulator = createSubagentToolUseAccumulator(sessionId, subagentId);
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  const seenEntryUuids = new Set<string>();
  try {
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // ISS-6454: skip the unparseable line, do not abandon the file. This
        // `catch` IS the proof that no half-read `tool_use` can reach
        // {@link extractToolUses} — a line that fails `JSON.parse` never
        // becomes an entry — so the split-block hazard the old bail guarded
        // against is unreachable from here. Kept in step with
        // `claude-parser.ts`'s pass deliberately: the two readers of this same
        // sidecar drifting is a standing hazard (see collectors/AGENTS.md).
        continue;
      }
      if (isReplayedTranscriptEntry(seenEntryUuids, entry)) {
        continue;
      }
      accumulateSubagentToolUseEntry(accumulator, entry);
    }
  } finally {
    rl.close();
  }

  return finalizedScanResult(accumulator);
}

/** Create one file-scoped exact native-id accumulator. */
export function createSubagentToolUseAccumulator(
  sessionId: string,
  subagentId: string
): SubagentToolUseAccumulator {
  return {
    actionsById: new Map(),
    resultsById: new Map(),
    unkeyedActions: [],
    conflictedIds: new Set(),
    sequence: 0,
    sessionId,
    subagentId,
  };
}

/**
 * Accumulate one parsed entry without assuming action/result arrival order.
 * Reused by the streaming scan and the parser's existing sidecar fold.
 */
export function accumulateSubagentToolUseEntry(
  accumulator: SubagentToolUseAccumulator,
  entry: Record<string, unknown>
): void {
  for (const action of toolUsesFromEntry(accumulator, entry)) {
    addAccumulatedAction(accumulator, action);
  }
  for (const result of toolResultsFromEntry(entry)) {
    addAccumulatedResult(accumulator, result.toolUseId, result.value);
  }
}

/** Join file-scoped actions and results, dropping every conflicted native id. */
export function finalizeSubagentToolUses(
  accumulator: SubagentToolUseAccumulator
): SubagentToolUseRecord[] {
  const accumulated = orderAccumulatedToolUses(
    [...accumulator.unkeyedActions, ...accumulator.actionsById.values()]
      .filter(
        (action) =>
          !(action.toolUseId && accumulator.conflictedIds.has(action.toolUseId))
      )
      .map((action) => joinAccumulatedResult(accumulator, action))
  );
  return accumulated.map(({ sequence: _sequence, ...toolUse }) => toolUse);
}

/**
 * Extract the tool-use records carried by ONE already-parsed transcript entry.
 *
 * ISS-5542: exported so a caller that already streams the sidecar for its own
 * reasons — `claude-parser.ts`'s `readAgentFile`, which replaced the deleted
 * `collectEntriesFromFile` in the ISS-6531 rewrite — can fold this
 * extraction into that pass instead of paying a second whole-file read and
 * `JSON.parse` through {@link scanSubagentTranscriptStream}. Such a caller owns
 * the guard the scanner applies around this function: the FEA-3453 replayed
 * `uuid` filter. It also owns skipping a line that fails `JSON.parse` — which
 * both readers now do, rather than abandoning the file's tool uses whole
 * (ISS-6454 dropped that bail from this scanner and from the parser's pass).
 */
export function extractToolUses(
  entry: Record<string, unknown>,
  sessionId: string,
  subagentId: string
): SubagentToolUseRecord[] {
  const accumulator = createSubagentToolUseAccumulator(sessionId, subagentId);
  accumulateSubagentToolUseEntry(accumulator, entry);
  return finalizeSubagentToolUses(accumulator);
}

function toolUsesFromEntry(
  accumulator: SubagentToolUseAccumulator,
  entry: Record<string, unknown>
): AccumulatedToolUse[] {
  const timestamp = normalizeTimestamp(entry.timestamp) || null;
  const flat = extractFlatToolUse(
    entry,
    accumulator.sessionId,
    accumulator.subagentId,
    timestamp,
    accumulator.sequence
  );
  if (flat) {
    accumulator.sequence += 1;
    return [flat];
  }

  const message = asRecord(entry.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const toolUses: AccumulatedToolUse[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (block?.type !== "tool_use") {
      continue;
    }
    const toolName =
      typeof block.name === "string" && block.name.length > 0
        ? block.name
        : null;
    if (!toolName) {
      continue;
    }
    toolUses.push({
      agentId: accumulator.subagentId,
      sessionId: accumulator.sessionId,
      toolUseId: typeof block.id === "string" ? block.id : null,
      requestKey: entryRequestKey(entry),
      toolName,
      timestamp,
      input: block.input === undefined ? null : block.input,
      output: null,
      outputFootprintTokens: null,
      resultFacts: null,
      resultTimestamp: null,
      isError: null,
      sequence: accumulator.sequence,
    });
    accumulator.sequence += 1;
  }
  return toolUses;
}

function extractFlatToolUse(
  entry: Record<string, unknown>,
  sessionId: string,
  subagentId: string,
  timestamp: string | null,
  sequence: number
): AccumulatedToolUse | null {
  if (entry.type !== "tool_use" && entry.type !== "tool_result") {
    return null;
  }
  const toolName =
    typeof entry.name === "string" && entry.name.length > 0 ? entry.name : null;
  if (!toolName) {
    return null;
  }
  return {
    agentId: subagentId,
    sessionId,
    toolUseId: typeof entry.id === "string" ? entry.id : null,
    requestKey: entryRequestKey(entry),
    toolName,
    timestamp,
    input: entry.input === undefined ? null : entry.input,
    output: stringifyBoundedResult(entry.result),
    outputFootprintTokens: flatResultFootprintTokens(entry.result),
    resultFacts: flatResultFacts(entry.result, entry.is_error === true),
    // One line carries both call and result, so no result instant was observed
    // (ISS-10713, tamsinb review on #8910): a copied line stamp read as 0ms.
    resultTimestamp: null,
    isError: typeof entry.is_error === "boolean" ? entry.is_error : null,
    sequence,
  };
}

function toolResultsFromEntry(
  entry: Record<string, unknown>
): Array<{ toolUseId: string; value: AccumulatedToolResult }> {
  const message = asRecord(entry.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const resultBlocks = content.flatMap((rawBlock) => {
    const block = asRecord(rawBlock);
    return block?.type === "tool_result" ? [block] : [];
  });
  const topLevelResult = asRecord(entry.toolUseResult);
  const unambiguousTopLevelError =
    resultBlocks.length === 1 && typeof topLevelResult?.is_error === "boolean"
      ? topLevelResult.is_error
      : null;
  const resultTimestamp = normalizeTimestamp(entry.timestamp) || null;
  const results: Array<{
    toolUseId: string;
    value: AccumulatedToolResult;
  }> = [];
  for (const block of resultBlocks) {
    if (
      typeof block.tool_use_id !== "string" ||
      block.tool_use_id.length === 0
    ) {
      continue;
    }
    const isError =
      typeof block.is_error === "boolean"
        ? block.is_error
        : unambiguousTopLevelError;
    const fullText = toolResultText(block);
    results.push({
      toolUseId: block.tool_use_id,
      value: {
        output: stringifyBoundedJsonString(
          toolResultText(block, MAX_STRINGIFIED_CHARS)
        ),
        // Uncapped on purpose: the line above deliberately caps what is CARRIED,
        // and this is the count of what was actually injected.
        outputFootprintTokens: estimateAgentComponentFootprintTokens(fullText),
        resultFacts: readUntypedToolResultFacts(fullText, isError === true),
        resultTimestamp,
        isError,
      },
    });
  }
  return results;
}

function addAccumulatedAction(
  accumulator: SubagentToolUseAccumulator,
  action: AccumulatedToolUse
): void {
  const id = action.toolUseId;
  if (!id) {
    accumulator.unkeyedActions.push(action);
    return;
  }
  if (accumulator.conflictedIds.has(id)) {
    return;
  }
  const existing = accumulator.actionsById.get(id);
  if (!existing) {
    accumulator.actionsById.set(id, action);
    return;
  }
  const merged = mergeAccumulatedActions(existing, action);
  if (!merged) {
    accumulator.actionsById.delete(id);
    accumulator.conflictedIds.add(id);
    return;
  }
  accumulator.actionsById.set(id, merged);
}

function addAccumulatedResult(
  accumulator: SubagentToolUseAccumulator,
  id: string,
  result: AccumulatedToolResult
): void {
  if (accumulator.conflictedIds.has(id)) {
    return;
  }
  const existing = accumulator.resultsById.get(id);
  if (!existing) {
    accumulator.resultsById.set(id, result);
    return;
  }
  if (!sameAccumulatedResult(existing, result)) {
    accumulator.resultsById.delete(id);
    accumulator.actionsById.delete(id);
    accumulator.conflictedIds.add(id);
    return;
  }
  accumulator.resultsById.set(id, {
    ...existing,
    isError: existing.isError ?? result.isError,
  });
}

function joinAccumulatedResult(
  accumulator: SubagentToolUseAccumulator,
  action: AccumulatedToolUse
): AccumulatedToolUse {
  if (!action.toolUseId) {
    return action;
  }
  const result = accumulator.resultsById.get(action.toolUseId);
  if (!result) {
    return action;
  }
  return {
    ...action,
    output: result.output,
    outputFootprintTokens: result.outputFootprintTokens,
    resultFacts: result.resultFacts,
    resultTimestamp: result.resultTimestamp,
    isError: result.isError,
  };
}

function mergeAccumulatedActions(
  left: AccumulatedToolUse,
  right: AccumulatedToolUse
): AccumulatedToolUse | null {
  const sameAction =
    left.agentId === right.agentId &&
    left.sessionId === right.sessionId &&
    left.toolUseId === right.toolUseId &&
    left.toolName === right.toolName &&
    left.timestamp === right.timestamp &&
    isDeepStrictEqual(left.input, right.input);
  if (!sameAction) {
    return null;
  }
  if (
    left.output !== null &&
    right.output !== null &&
    (left.output !== right.output ||
      left.resultTimestamp !== right.resultTimestamp ||
      (left.isError === true) !== (right.isError === true))
  ) {
    return null;
  }
  const completed = left.output === null ? right : left;
  return {
    ...left,
    output: completed.output,
    outputFootprintTokens: completed.outputFootprintTokens,
    resultFacts: completed.resultFacts,
    resultTimestamp: completed.resultTimestamp,
    isError: completed.output === null ? null : completed.isError,
    sequence: Math.min(left.sequence, right.sequence),
  };
}

function sameAccumulatedResult(
  left: AccumulatedToolResult,
  right: AccumulatedToolResult
): boolean {
  return (
    left.output === right.output &&
    left.resultTimestamp === right.resultTimestamp &&
    (left.isError === true) === (right.isError === true)
  );
}

function orderAccumulatedToolUses(
  toolUses: AccumulatedToolUse[]
): AccumulatedToolUse[] {
  let latestSortableTimestamp = "";
  // An unreadable stamp inherits the prior time bucket so source sequence keeps
  // it between the surrounding readable records instead of moving it to an end.
  const sortable = toolUses
    .sort((left, right) => left.sequence - right.sequence)
    .map((toolUse) => {
      if (toolUse.timestamp) {
        latestSortableTimestamp = toolUse.timestamp;
      }
      return { sortTimestamp: latestSortableTimestamp, toolUse };
    });
  sortable.sort(
    (left, right) =>
      left.sortTimestamp.localeCompare(right.sortTimestamp) ||
      left.toolUse.sequence - right.toolUse.sequence ||
      (left.toolUse.toolUseId ?? "").localeCompare(
        right.toolUse.toolUseId ?? ""
      )
  );
  return sortable.map(({ toolUse }) => toolUse);
}

function finalizedScanResult(
  accumulator: SubagentToolUseAccumulator
): SubagentScanResult {
  return {
    toolUses: finalizeSubagentToolUses(accumulator),
    conflictedToolUseIds: [...accumulator.conflictedIds].sort(),
  };
}

/**
 * ISS-10736: the footprint of a FLAT entry's inline `result`, counted over the
 * whole serialization rather than the bounded one `output` carries.
 *
 * A string result is counted as itself: `stringifyBoundedResult` JSON-encodes
 * it, but the text the model actually received is the string, not its quoting.
 */
/** ISS-12552: result facts for a flat entry's result, read before bounding. */
function flatResultFacts(
  result: unknown,
  isError: boolean
): UntypedToolResultFacts | null {
  if (result === undefined || result === null) {
    return null;
  }
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text === undefined ? null : readUntypedToolResultFacts(text, isError);
}

function flatResultFootprintTokens(result: unknown): number | null {
  if (result === undefined || result === null) {
    return null;
  }
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text === undefined
    ? null
    : estimateAgentComponentFootprintTokens(text);
}

/**
 * ISS-12552 (PRD-800): the request a sidecar tool call came from,
 * named by its own transcript line, which that request's usage identity lists.
 */
function entryRequestKey(entry: Record<string, unknown>): string | null {
  return typeof entry.uuid === "string" && entry.uuid.length > 0
    ? requestKeyFor(claudeTranscriptEntryUuidScheme, entry.uuid)
    : null;
}

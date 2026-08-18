/**
 * @file subagent-scanner.ts
 * @description Live-hook subagent JSONL scanner (Gap 6). When triggered (by
 * SubagentStop or periodic check), reads the subagent's own transcript file
 * and creates per-subagent tool-call events attributed to the correct subagent
 * agent_id. This enables per-subagent cost breakdowns and tool-usage heatmaps
 * in the live-hook path, matching the boot importer's behavior.
 */

import { createReadStream, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { isReplayedTranscriptEntry } from "@repo/lib/harness/claude/replayed-entry";
import { asRecord } from "../../../shared/type-guards.js";

export type SubagentToolUseRecord = {
  agentId: string;
  sessionId: string;
  /** Native Claude tool_use block id; preserves identity for same-ms events. */
  toolUseId: string | null;
  toolName: string;
  timestamp: string | null;
  input: string | null;
  output: string | null;
};

export type SubagentScanResult = {
  toolUses: SubagentToolUseRecord[];
};

function normalizeTimestamp(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "number") {
    return new Date(raw).toISOString();
  }
  return "";
}

/**
 * Read a subagent JSONL transcript file and extract tool_use blocks.
 * Returns the list of tool-use records suitable for insertion as
 * PostToolUse events on the subagent's agent_id.
 *
 * The subagent transcript path convention follows Claude Code's output
 * directory layout: <parentTranscriptDir>/<sessionId>/subagents/agent-*.jsonl.
 * The caller resolves the native `agent-*` id from persisted agent metadata.
 *
 * ISS-5426 (wongk review, PR #4715): resume/compaction-REPLAYED entries are
 * dropped by `uuid` before extraction — see {@link scanSubagentTranscriptStream}
 * for why this scanner needs its own copy of the FEA-3453 filter.
 */
export function scanSubagentTranscript(
  filePath: string,
  sessionId: string,
  subagentId: string
): SubagentScanResult {
  try {
    statSync(filePath);
  } catch {
    return { toolUses: [] };
  }

  const toolUses: SubagentToolUseRecord[] = [];
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return { toolUses: [] };
  }

  const seenEntryUuids = new Set<string>();
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { toolUses: [] };
    }
    if (isReplayedTranscriptEntry(seenEntryUuids, entry)) {
      continue;
    }
    toolUses.push(...extractToolUses(entry, sessionId, subagentId));
  }

  return { toolUses };
}

/**
 * Async streaming version of the subagent scanner. Prefer this for production
 * use on large files; the sync version above is kept for simpler callers.
 *
 * ISS-5426 (wongk review, PR #4715): resume/compaction REPLAYS are dropped by
 * `uuid` (FEA-3453) before extraction. A caller-side `tool_use.id` dedup cannot
 * stand in for that filter — `tool_use.id` is raw transcript JSON and may be
 * absent, so an IDLESS replayed tool use would be merged twice and ride on into
 * every downstream projection (the skills derivation, the per-subagent tool
 * events, the tool heatmaps). The filter lives here rather than at the call site
 * so BOTH scanner entry points read a replayed transcript identically, and so
 * the guard cannot be forgotten by a future caller. Scoped per CALL, matching
 * the per-file scoping of the parser's set.
 *
 * ISS-5542: the boot importer no longer calls this. `claude-parser.ts` already
 * streams every sidecar once through `collectEntriesFromFile`, and now folds
 * {@link extractToolUses} into that pass rather than re-opening and re-parsing
 * the same file here. The live-hook path (`database/live-hook.ts`), which has no
 * such pass of its own, is this function's remaining caller.
 */
export async function scanSubagentTranscriptStream(
  filePath: string,
  sessionId: string,
  subagentId: string
): Promise<SubagentScanResult> {
  try {
    statSync(filePath);
  } catch {
    return { toolUses: [] };
  }

  const toolUses: SubagentToolUseRecord[] = [];
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
        return { toolUses: [] };
      }
      if (isReplayedTranscriptEntry(seenEntryUuids, entry)) {
        continue;
      }
      toolUses.push(...extractToolUses(entry, sessionId, subagentId));
    }
  } finally {
    rl.close();
  }

  return { toolUses };
}

/**
 * Extract the tool-use records carried by ONE already-parsed transcript entry.
 *
 * ISS-5542: exported so a caller that already streams the sidecar for its own
 * reasons — `claude-parser.ts`'s `collectEntriesFromFile` — can fold this
 * extraction into that pass instead of paying a second whole-file read and
 * `JSON.parse` through {@link scanSubagentTranscriptStream}. Such a caller owns
 * the two guards the scanners apply around this function: the FEA-3453 replayed
 * `uuid` filter, and the whole-file bail on a malformed line.
 */
export function extractToolUses(
  entry: Record<string, unknown>,
  sessionId: string,
  subagentId: string
): SubagentToolUseRecord[] {
  const timestamp = normalizeTimestamp(entry.timestamp) || null;
  const flat = extractFlatToolUse(entry, sessionId, subagentId, timestamp);
  if (flat) {
    return [flat];
  }

  const message = asRecord(entry.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const toolUses: SubagentToolUseRecord[] = [];
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
      agentId: subagentId,
      sessionId,
      toolUseId: typeof block.id === "string" ? block.id : null,
      toolName,
      timestamp,
      input: stringifyBounded(block.input),
      output: null,
    });
  }
  return toolUses;
}

function extractFlatToolUse(
  entry: Record<string, unknown>,
  sessionId: string,
  subagentId: string,
  timestamp: string | null
): SubagentToolUseRecord | null {
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
    toolName,
    timestamp,
    input: stringifyBounded(entry.input),
    output: stringifyBounded(entry.result),
  };
}

/** Character ceiling for a serialized tool-use `input`/`output` preview. */
export const MAX_STRINGIFIED_CHARS = 1000;

/**
 * Serialize `value` down to at most {@link MAX_STRINGIFIED_CHARS} characters,
 * bounding the WORK rather than only the RESULT (ISS-5543).
 *
 * A `Write`/`Edit` tool_use carries a whole source file in its input, so the
 * previous `JSON.stringify(value).slice(0, 1000)` allocated the entire multi-KB
 * document per tool use just to keep 1 KB of it — once per tool_use on the
 * boot-import path and again per `SubagentStop` on the live-hook path. The
 * replacer here spends a budget shared across the whole value's string content,
 * so no oversized string is ever copied into a result that is about to be thrown
 * away. A payload whose full serialization would exceed V8's maximum string
 * length now yields its bounded prefix instead of throwing.
 *
 * The output is byte-identical to the old form, which is deliberate: these
 * records reach `session.subagents[].toolUses`, and the artifact-ref extractor
 * reads them. The budget can only run out at an output offset at or past the
 * `slice` cut (escaping only ever lengthens a string), so nothing inside the
 * kept prefix shifts — no re-derivation constant needs to move.
 */
export function stringifyBounded(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  let remaining = MAX_STRINGIFIED_CHARS;
  const boundStrings = (_key: string, raw: unknown): unknown => {
    if (typeof raw !== "string") {
      return raw;
    }
    const kept = raw.length > remaining ? raw.slice(0, remaining) : raw;
    remaining -= kept.length;
    return kept;
  };
  try {
    const json = JSON.stringify(value, boundStrings);
    return json === undefined ? null : json.slice(0, MAX_STRINGIFIED_CHARS);
  } catch {
    return null;
  }
}

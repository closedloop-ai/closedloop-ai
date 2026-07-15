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
    toolUses.push(...extractToolUses(entry, sessionId, subagentId));
  }

  return { toolUses };
}

/**
 * Async streaming version of the subagent scanner. Prefer this for production
 * use on large files; the sync version above is kept for simpler callers.
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
      toolUses.push(...extractToolUses(entry, sessionId, subagentId));
    }
  } finally {
    rl.close();
  }

  return { toolUses };
}

function extractToolUses(
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

function stringifyBounded(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value).slice(0, 1000);
  } catch {
    return null;
  }
}

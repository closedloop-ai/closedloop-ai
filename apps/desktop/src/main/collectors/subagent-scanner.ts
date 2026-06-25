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

export type SubagentToolUseRecord = {
  agentId: string;
  sessionId: string;
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
 * The subagent transcript path convention follows Claude Code's
 * output directory layout: <session_dir>/<subagent_id>.jsonl
 * where the subagent_id (toolu_*) matches the agent row's id suffix.
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
      continue;
    }
    if (entry.type !== "tool_use" && entry.type !== "tool_result") {
      continue;
    }
    const toolName =
      typeof entry.name === "string" && entry.name.length > 0
        ? entry.name
        : null;
    if (!toolName) {
      continue;
    }
    const ts = normalizeTimestamp(entry.timestamp);
    const input =
      entry.input === undefined
        ? null
        : JSON.stringify(entry.input).slice(0, 1000);
    const output =
      entry.result === undefined
        ? null
        : JSON.stringify(entry.result).slice(0, 1000);

    toolUses.push({
      agentId: subagentId,
      sessionId,
      toolName,
      timestamp: ts || null,
      input,
      output,
    });
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
        continue;
      }
      if (entry.type !== "tool_use" && entry.type !== "tool_result") {
        continue;
      }
      const toolName =
        typeof entry.name === "string" && entry.name.length > 0
          ? entry.name
          : null;
      if (!toolName) {
        continue;
      }
      const ts = normalizeTimestamp(entry.timestamp);
      const input =
        entry.input === undefined
          ? null
          : JSON.stringify(entry.input).slice(0, 1000);
      const output =
        entry.result === undefined
          ? null
          : JSON.stringify(entry.result).slice(0, 1000);

      toolUses.push({
        agentId: subagentId,
        sessionId,
        toolName,
        timestamp: ts || null,
        input,
        output,
      });
    }
  } finally {
    rl.close();
  }

  return { toolUses };
}

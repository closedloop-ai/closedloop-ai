import type {
  AgentSession,
  ConversationEntry,
  ExecutionTrace,
  SessionIndexEntry,
  SessionStats,
  ToolCall,
} from "@repo/api/src/types/execution-log";
import { log } from "@repo/observability/log";
import AdmZip from "adm-zip";

// Top-level regex patterns for performance
const CONVERSATION_FILE_REGEX = /\.claude\/runs\/conversations\/.*\.jsonl$/;
const COMMAND_NAME_REGEX = /<command-name>(.*?)<\/command-name>/;

/**
 * Find session files from zip entries using sessions-index.json or directory scan
 */
function findSessionFiles(
  entries: AdmZip.IZipEntry[]
): { sessionId: string; data: Buffer }[] {
  // Try sessions-index.json first
  const sessionsIndexEntry = entries.find((e) =>
    e.entryName.endsWith(".claude/runs/conversations/sessions-index.json")
  );

  if (sessionsIndexEntry) {
    const indexData = sessionsIndexEntry.getData();
    const sessionIndex = parseSessionIndex(indexData);
    const sessionFiles: { sessionId: string; data: Buffer }[] = [];

    for (const session of sessionIndex) {
      const sessionEntry = entries.find((e) =>
        e.entryName.endsWith(session.path)
      );
      if (sessionEntry) {
        sessionFiles.push({
          sessionId: session.sessionId,
          data: sessionEntry.getData(),
        });
      }
    }

    return sessionFiles;
  }

  // Fallback: directory scan for *.jsonl files
  log.warn(
    "[execution-log-parser] sessions-index.json not found, scanning for JSONL files"
  );
  const conversationFiles = entries.filter((e) =>
    e.entryName.match(CONVERSATION_FILE_REGEX)
  );

  return conversationFiles.map((entry) => {
    const fileName = entry.entryName.split("/").pop() || "";
    const sessionId = fileName.replace(".jsonl", "");
    return { sessionId, data: entry.getData() };
  });
}

/**
 * Parse a single session file into an AgentSession
 */
function parseSessionFile(
  sessionId: string,
  data: Buffer
): AgentSession | null {
  const entries = parseConversationJsonl(data);
  if (entries.length === 0) {
    return null;
  }

  // Derive agent label from first prompt
  const firstUserEntry = entries.find((e) => e.role === "user");
  const agentLabel = firstUserEntry
    ? deriveAgentLabel(firstUserEntry.content)
    : "Unknown Agent";

  // Compute stats
  const toolCallCount = entries.reduce(
    (sum, e) => sum + (e.toolCalls?.length ?? 0),
    0
  );
  // Safe to assert: entries.length > 0 is checked above
  const firstTimestamp = new Date(entries[0]!.timestamp).getTime();
  const lastEntry = entries.at(-1);
  const lastTimestamp = lastEntry
    ? new Date(lastEntry.timestamp).getTime()
    : firstTimestamp;
  const duration = lastTimestamp - firstTimestamp;

  const stats: SessionStats = {
    messageCount: entries.length,
    toolCallCount,
    duration: duration > 0 ? duration : null,
  };

  return {
    sessionId,
    agentLabel,
    parentSessionId: null, // TODO: extract from metadata if available
    entries,
    stats,
  };
}

/**
 * Main entry point: extract zip, find conversation logs, parse sessions, return ExecutionTrace
 */
export function parseExecutionLogs(zipBuffer: Buffer): ExecutionTrace {
  try {
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();

    const sessionFiles = findSessionFiles(entries);
    const sessions = sessionFiles
      .map(({ sessionId, data }) => parseSessionFile(sessionId, data))
      .filter((s): s is AgentSession => s !== null);

    return buildExecutionTrace(sessions);
  } catch (error) {
    log.error("[execution-log-parser] Failed to parse execution logs", {
      error: error instanceof Error ? error.message : String(error),
    });
    return createEmptyExecutionTrace();
  }
}

/**
 * Parse sessions-index.json
 */
export function parseSessionIndex(buffer: Buffer): SessionIndexEntry[] {
  try {
    const content = buffer.toString("utf-8");
    const data = JSON.parse(content);

    if (!Array.isArray(data)) {
      log.warn("[execution-log-parser] sessions-index.json is not an array");
      return [];
    }

    return data.filter(
      (item): item is SessionIndexEntry =>
        typeof item === "object" &&
        item !== null &&
        typeof item.sessionId === "string" &&
        typeof item.path === "string" &&
        typeof item.created === "string"
    );
  } catch (error) {
    log.error("[execution-log-parser] Failed to parse sessions-index.json", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Normalize content from JSONL record (string or array of blocks)
 */
function normalizeRecordContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const textBlocks = content.filter(
      (block: { type?: string; text?: string }) => block.type === "text"
    );
    return textBlocks
      .map((block: { text?: string }) => block.text || "")
      .join("\n");
  }
  return "";
}

/**
 * Extract tool calls from record content blocks
 */
function extractToolCalls(content: unknown): ToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const toolUseBlocks = content.filter(
    (block: { type?: string }) => block.type === "tool_use"
  );
  const toolResultBlocks = content.filter(
    (block: { type?: string }) => block.type === "tool_result"
  );

  // Map tool results by tool_use_id for quick lookup
  const toolResultsMap = new Map<string, string>();
  for (const result of toolResultBlocks) {
    if (result.tool_use_id && typeof result.content === "string") {
      toolResultsMap.set(result.tool_use_id, result.content);
    }
  }

  // Process tool_use blocks
  return toolUseBlocks.map((toolUse): ToolCall => {
    let result = toolResultsMap.get(toolUse.id) ?? null;
    let truncated: boolean | undefined;

    // Truncate tool results to 100 lines + 10k chars
    if (result) {
      const lines = result.split("\n");
      if (lines.length > 100 || result.length > 10_000) {
        result = lines.slice(0, 100).join("\n").slice(0, 10_000);
        truncated = true;
      }
    }

    return {
      name: toolUse.name || "unknown",
      input: toolUse.input || {},
      result,
      truncated,
    };
  });
}

/**
 * Parse JSONL conversation file
 */
export function parseConversationJsonl(buffer: Buffer): ConversationEntry[] {
  try {
    const content = buffer.toString("utf-8");
    const lines = content.split("\n").filter((line) => line.trim() !== "");

    const entries: ConversationEntry[] = [];

    for (const line of lines) {
      try {
        const record = JSON.parse(line);

        // Filter to user/assistant roles only
        if (record.role !== "user" && record.role !== "assistant") {
          continue;
        }

        const normalizedContent = normalizeRecordContent(record.content);
        const toolCalls = extractToolCalls(record.content);

        entries.push({
          role: record.role,
          content: normalizedContent,
          timestamp: record.timestamp || new Date().toISOString(),
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      } catch (error) {
        // Skip malformed lines
        log.warn("[execution-log-parser] Skipping malformed JSONL line", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return entries;
  } catch (error) {
    log.error("[execution-log-parser] Failed to parse conversation JSONL", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Derive agent label from first prompt by extracting from <command-name> tags
 */
export function deriveAgentLabel(firstPrompt: string): string {
  // Extract from <command-name> tags
  const match = firstPrompt.match(COMMAND_NAME_REGEX);
  if (match?.[1]) {
    const commandName = match[1].trim();

    // Map known patterns
    const labelMap: Record<string, string> = {
      "/experimental:code": "Orchestrator",
      "plan-writer": "Plan Writer",
      "implementation-subagent": "Implementation",
      "verification-subagent": "Verification",
      "prd-writer": "PRD Writer",
      "issue-writer": "Issue Writer",
    };

    return labelMap[commandName] || commandName;
  }

  // Fallback: first 50 chars of prompt
  return (
    firstPrompt.slice(0, 50).trim() + (firstPrompt.length > 50 ? "..." : "")
  );
}

/**
 * Build execution trace by aggregating session stats
 */
export function buildExecutionTrace(sessions: AgentSession[]): ExecutionTrace {
  const totalMessages = sessions.reduce(
    (sum, s) => sum + s.stats.messageCount,
    0
  );
  const totalToolCalls = sessions.reduce(
    (sum, s) => sum + s.stats.toolCallCount,
    0
  );

  // Calculate overall duration (earliest to latest timestamp across all sessions)
  let overallDuration: number | null = null;
  if (sessions.length > 0) {
    const allTimestamps = sessions.flatMap((s) =>
      s.entries.map((e) => new Date(e.timestamp).getTime())
    );
    const earliest = Math.min(...allTimestamps);
    const latest = Math.max(...allTimestamps);
    overallDuration = latest - earliest;
  }

  return {
    sessions,
    totalSessions: sessions.length,
    totalMessages,
    totalToolCalls,
    overallDuration,
  };
}

/**
 * Create empty execution trace (for error cases or no logs found)
 */
export function createEmptyExecutionTrace(): ExecutionTrace {
  return {
    sessions: [],
    totalSessions: 0,
    totalMessages: 0,
    totalToolCalls: 0,
    overallDuration: null,
  };
}

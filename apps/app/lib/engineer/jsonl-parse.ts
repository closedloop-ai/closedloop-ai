/**
 * Shared JSONL parsing helpers for claude-output.jsonl.
 *
 * Used by both JsonlLogViewer (UI) and jsonl-activity (status API).
 */

/**
 * Parsed content block from a message
 */
export type ContentBlock = {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string | unknown[];
  is_error?: boolean;
};

/**
 * Entry types emitted by the Claude CLI JSONL output
 */
export type LogEntryType =
  | "user"
  | "assistant"
  | "system"
  | "progress"
  | "queue-operation"
  | "file-history-snapshot";

/**
 * Lightweight parsed JSONL entry (no uuid/rawLine — those are viewer-only)
 */
export type ParsedLogEntry = {
  type: LogEntryType;
  parentToolUseId?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  data?: {
    type?: string;
    subtype?: string;
    hookEvent?: string;
    hookName?: string;
    command?: string;
  };
};

/**
 * Parse a single JSONL line into a ParsedLogEntry.
 * Returns null for malformed JSON or unknown entry types.
 */
export function parseJsonlLine(line: string): ParsedLogEntry | null {
  try {
    const parsed = JSON.parse(line);
    const entryType = parsed.type;

    // Map system entries
    if (entryType === "system") {
      return {
        type: "system",
        parentToolUseId: parsed.parent_tool_use_id,
        message: undefined,
        data: {
          type: entryType,
          subtype: parsed.subtype,
          hookEvent: parsed.hook_event,
          hookName: parsed.hook_name,
        },
      };
    }

    // Skip unknown types (e.g. result, content_block_delta)
    if (
      ![
        "user",
        "assistant",
        "progress",
        "queue-operation",
        "file-history-snapshot",
      ].includes(entryType)
    ) {
      return null;
    }

    return {
      type: entryType,
      parentToolUseId: parsed.parent_tool_use_id,
      message: parsed.message,
      data: parsed.data,
    };
  } catch {
    return null;
  }
}

/**
 * Check if a parsed entry is a tool result (vs an actual user prompt).
 */
export function isToolResultEntry(entry: ParsedLogEntry): boolean {
  if (entry.type !== "user") {
    return false;
  }
  const content = entry.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => block.type === "tool_result");
}

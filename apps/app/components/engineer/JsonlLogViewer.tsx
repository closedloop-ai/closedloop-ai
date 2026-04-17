"use client";

import { cn } from "@repo/design-system/lib/utils";
import {
  Activity,
  ArrowDown,
  Bot,
  Search,
  Sparkles,
  Terminal,
  User,
  Workflow,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CollapsibleBlock } from "@/components/chat/CollapsibleBlock";
import {
  extractToolResultText,
  SubagentBlock,
} from "@/components/chat/SubagentBlock";
import { isTerminalOutput } from "@/lib/chat/chat-utils";
import {
  type ContentBlock,
  isToolResultEntry as isToolResultEntryShared,
  type ParsedLogEntry,
  parseJsonlLine,
} from "@/lib/engineer/jsonl-parse";

/**
 * Filter options for JSONL log entries
 */
export type LogFilter =
  | "all"
  | "user"
  | "assistant"
  | "tool"
  | "subagent"
  | "progress";

/**
 * Message content type - can be a string, array of content blocks, or undefined
 */
type MessageContent = string | ContentBlock[] | undefined;

/**
 * Viewer-specific log entry extending the shared ParsedLogEntry with UI fields
 */
type LogEntry = ParsedLogEntry & {
  uuid: string;
  timestamp: string;
  rawLine: string;
};

/**
 * A subagent's work, grouped from entries sharing the same parent_tool_use_id
 */
type SubagentGroup = {
  toolUseId: string;
  description: string;
  /** e.g. "code:implementation-subagent" */
  agentType?: string;
  content: ContentBlock[];
};

/**
 * Grouped entry — consecutive assistant blocks merged into one bubble
 */
type GroupedEntry = {
  uuid: string;
  type: LogEntry["type"];
  timestamp: string;
  /** Merged content blocks from consecutive assistant entries */
  content: ContentBlock[];
  /** Nested subagent work, rendered as collapsible sections */
  subagentGroups?: SubagentGroup[];
  /** For user/system entries that aren't grouped */
  message?: LogEntry["message"];
  data?: LogEntry["data"];
};

type JsonlLogViewerProps = {
  lines: string[];
  className?: string;
};

/**
 * Parse a JSONL line into a viewer-specific LogEntry (adds uuid, timestamp, rawLine)
 */
function parseLogLine(line: string): LogEntry | null {
  const base = parseJsonlLine(line);
  if (!base) {
    return null;
  }

  return {
    ...base,
    uuid: base.uuid || crypto.randomUUID(),
    timestamp: base.timestamp || "",
    rawLine: line,
  };
}

/**
 * Check if a user entry is a tool result (vs an actual user prompt)
 */
function isToolResultEntry(entry: LogEntry): boolean {
  return isToolResultEntryShared(entry);
}

/**
 * Check if an entry's content should be folded into the current assistant turn.
 * Assistant entries and tool_result user entries are part of the same turn.
 */
function isTurnContinuation(entry: LogEntry): boolean {
  if (entry.parentToolUseId) {
    return false;
  }
  if (entry.type === "assistant") {
    return true;
  }
  return isToolResultEntry(entry);
}

/**
 * Convert a non-turn entry into a GroupedEntry for direct rendering.
 */
function toStandaloneGroup(entry: LogEntry): GroupedEntry {
  const content = entry.message?.content;
  return {
    uuid: entry.uuid,
    type: entry.type,
    timestamp: entry.timestamp,
    content: Array.isArray(content) ? content : [],
    message: entry.message,
    data: entry.data,
  };
}

/**
 * Group entries into coherent "turns" matching the chat interface.
 *
 * A turn includes: assistant text + tool_use + tool_result blocks all in one
 * bubble (with tool calls/results collapsible). This mirrors how
 * processStreamEvent in stream-events.ts accumulates blocks.
 *
 * A new turn starts when we encounter:
 * - An actual user TEXT message (the next prompt to Claude)
 * - A system/progress entry
 */
function groupEntries(entries: LogEntry[]): GroupedEntry[] {
  const groups: GroupedEntry[] = [];
  let turnBlocks: ContentBlock[] = [];
  let turnUuid = "";
  let turnTimestamp = "";

  // Track Task tool_use id → { description, agentType } for subagent labels
  const taskMeta = new Map<
    string,
    { description: string; agentType?: string }
  >();
  // Accumulate subagent content keyed by parentToolUseId
  const subagentMap = new Map<string, ContentBlock[]>();

  function buildSubagentGroups(): SubagentGroup[] {
    const result: SubagentGroup[] = [];
    for (const [toolUseId, content] of subagentMap) {
      const meta = taskMeta.get(toolUseId);
      result.push({
        toolUseId,
        description: meta?.description || "Subagent",
        agentType: meta?.agentType,
        content,
      });
    }
    subagentMap.clear();
    return result;
  }

  function flushTurn() {
    if (turnBlocks.length === 0) {
      return;
    }
    const subagentGroups = buildSubagentGroups();
    groups.push({
      uuid: turnUuid,
      type: "assistant",
      timestamp: turnTimestamp,
      content: [...turnBlocks],
      subagentGroups: subagentGroups.length > 0 ? subagentGroups : undefined,
    });
    turnBlocks = [];
  }

  function recordTaskMeta(blocks: unknown[]) {
    for (const block of blocks) {
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use" || b.name !== "Task" || !b.id) {
        continue;
      }
      const input = b.input as Record<string, unknown> | undefined;
      if (typeof input?.description !== "string") {
        continue;
      }
      taskMeta.set(b.id as string, {
        description: input.description,
        agentType:
          typeof input.subagent_type === "string"
            ? input.subagent_type
            : undefined,
      });
    }
  }

  function appendToTurn(entry: LogEntry) {
    if (turnBlocks.length === 0) {
      turnUuid = entry.uuid;
      turnTimestamp = entry.timestamp;
    }
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      recordTaskMeta(content);
      turnBlocks.push(...content);
    } else if (typeof content === "string" && content.trim()) {
      turnBlocks.push({ type: "text", text: content });
    }
  }

  function appendToSubagent(entry: LogEntry) {
    const parentId = entry.parentToolUseId!;
    const content = entry.message?.content;
    if (!subagentMap.has(parentId)) {
      subagentMap.set(parentId, []);
    }
    const blocks = subagentMap.get(parentId)!;
    if (Array.isArray(content)) {
      blocks.push(...content);
    } else if (typeof content === "string" && content.trim()) {
      blocks.push({ type: "text", text: content });
    }
  }

  for (const entry of entries) {
    if (entry.parentToolUseId) {
      appendToSubagent(entry);
    } else if (isTurnContinuation(entry) && entry.message?.content) {
      appendToTurn(entry);
    } else {
      flushTurn();
      groups.push(toStandaloneGroup(entry));
    }
  }

  flushTurn();
  return groups;
}

/**
 * Get text content from message content (handles both string and array formats)
 */
function getMessageText(content: MessageContent): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (block): block is ContentBlock =>
        block.type === "text" && typeof block.text === "string"
    )
    .map((block) => block.text || "")
    .join("\n");
}

/**
 * Check if content blocks contain tool_use blocks
 */
function hasToolUse(blocks: ContentBlock[]): boolean {
  return blocks.some((block) => block.type === "tool_use");
}

/**
 * Check if content blocks contain tool_result blocks
 */
function hasToolResult(blocks: ContentBlock[]): boolean {
  return blocks.some((block) => block.type === "tool_result");
}

/**
 * Check if grouped entry matches the filter
 */
function matchesFilter(entry: GroupedEntry, filter: LogFilter): boolean {
  if (filter === "all") {
    return true;
  }

  // Tool results come as "user" type but should be categorized as tools
  const isToolResultEntry =
    entry.type === "user" && hasToolResult(entry.content);

  if (filter === "user") {
    return entry.type === "user" && !isToolResultEntry;
  }
  if (filter === "assistant") {
    return entry.type === "assistant";
  }
  if (filter === "tool") {
    const hasToolCall = entry.type === "assistant" && hasToolUse(entry.content);
    return hasToolCall || isToolResultEntry;
  }
  if (filter === "subagent") {
    return (entry.subagentGroups?.length ?? 0) > 0;
  }
  if (filter === "progress") {
    return (
      entry.type === "system" ||
      entry.type === "progress" ||
      entry.type === "queue-operation"
    );
  }
  return true;
}

/**
 * Get searchable text from a tool_result block
 */
function getToolResultText(block: ContentBlock): string {
  return extractToolResultText(block.content);
}

/**
 * Check if a content block matches the search query
 */
function blockMatchesQuery(block: ContentBlock, lowerQuery: string): boolean {
  if (block.type === "tool_use") {
    if (block.name?.toLowerCase().includes(lowerQuery)) {
      return true;
    }
    if (JSON.stringify(block.input).toLowerCase().includes(lowerQuery)) {
      return true;
    }
  }
  if (
    block.type === "tool_result" &&
    getToolResultText(block).toLowerCase().includes(lowerQuery)
  ) {
    return true;
  }
  return false;
}

/**
 * Check if grouped entry matches the search query
 */
function matchesSearch(entry: GroupedEntry, query: string): boolean {
  if (!query.trim()) {
    return true;
  }
  const lowerQuery = query.toLowerCase();

  const messageText = getMessageText(entry.content);
  if (messageText.toLowerCase().includes(lowerQuery)) {
    return true;
  }

  if (entry.content.some((block) => blockMatchesQuery(block, lowerQuery))) {
    return true;
  }

  if (entry.data?.hookName?.toLowerCase().includes(lowerQuery)) {
    return true;
  }

  if (entry.data?.subtype?.toLowerCase().includes(lowerQuery)) {
    return true;
  }

  if (entry.data?.resultText?.toLowerCase().includes(lowerQuery)) {
    return true;
  }

  // Search within subagent group content
  if (
    entry.subagentGroups?.some((group) => {
      if (group.description.toLowerCase().includes(lowerQuery)) {
        return true;
      }
      const subText = getMessageText(group.content);
      if (subText.toLowerCase().includes(lowerQuery)) {
        return true;
      }
      return group.content.some((block) =>
        blockMatchesQuery(block, lowerQuery)
      );
    })
  ) {
    return true;
  }

  return false;
}

/**
 * Highlight search matches in text
 */
function highlightMatches(text: string, query: string): React.ReactNode {
  if (!query.trim()) {
    return text;
  }

  const escapedQuery = query.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const parts = text.split(new RegExp(`(${escapedQuery})`, "gi"));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark
        className="rounded bg-primary/20 px-0.5 font-medium text-foreground"
        key={`${i}-${part}`}
      >
        {part}
      </mark>
    ) : (
      part
    )
  );
}

/**
 * Format timestamp for display
 */
function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

function formatCurrency(usd: number): string {
  if (usd === 0) {
    return "$0";
  }
  if (usd < 0.01) {
    return "<$0.01";
  }
  return `$${usd.toFixed(2)}`;
}

/**
 * Markdown components for log message rendering
 */
const logMarkdownComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="mt-4 mb-2 font-semibold text-foreground text-lg first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="mt-3 mb-1.5 font-semibold text-base text-foreground">
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mt-2.5 mb-1 font-semibold text-foreground text-sm">
      {children}
    </h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="my-1.5 leading-relaxed">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="leading-relaxed">{children}</li>
  ),
  code: ({
    className,
    children,
  }: {
    className?: string;
    children?: React.ReactNode;
  }) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code className="rounded bg-muted/80 px-1.5 py-0.5 font-mono text-[13px] text-amber-700 dark:bg-muted/50 dark:text-amber-300">
          {children}
        </code>
      );
    }
    return <code className={className}>{children}</code>;
  },
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-border/50 bg-muted/60 p-3 font-mono text-xs dark:bg-muted/40">
      {children}
    </pre>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="bg-muted/40">{children}</thead>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-border/50 px-2 py-1.5 text-left font-semibold text-xs">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-border/50 px-2 py-1.5 text-xs">{children}</td>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-2 border-primary/40 border-l-2 pl-3 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      className="text-primary hover:underline"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-3 border-border/50" />,
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
};

/**
 * Hook for managing expandable/collapsible state with Set-based tracking
 */
function useExpandedState(): [Set<string>, (id: string) => void] {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  return [expanded, toggle];
}

/**
 * Component to render a user message
 */
function UserMessage({
  content,
  searchQuery,
}: Readonly<{
  content: string | ContentBlock[];
  searchQuery: string;
}>) {
  const text = getMessageText(content);
  if (
    text.includes("<local-command-caveat>") ||
    text.includes("<local-command-stdout>")
  ) {
    return null;
  }
  const cleanText = text
    .replaceAll(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replaceAll(/<command-message>([\s\S]*?)<\/command-message>/g, "$1")
    .replaceAll(/<command-args>[\s\S]*?<\/command-args>/g, "")
    .trim();

  if (!cleanText) {
    return null;
  }

  // Terminal output: render as preformatted monospace with horizontal scroll
  if (isTerminalOutput(cleanText)) {
    return (
      <div className="whitespace-pre font-mono text-foreground/90 text-sm leading-relaxed">
        {highlightMatches(cleanText, searchQuery)}
      </div>
    );
  }

  // Search mode: render as preformatted text with wrapping
  if (searchQuery.trim()) {
    return (
      <div className="whitespace-pre-wrap text-foreground/90 text-sm leading-relaxed">
        {highlightMatches(cleanText, searchQuery)}
      </div>
    );
  }

  return (
    <div className="log-prose text-foreground/90 text-sm">
      <ReactMarkdown
        components={logMarkdownComponents}
        remarkPlugins={[remarkGfm, remarkBreaks]}
      >
        {cleanText}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Component to render an assistant message
 */
function AssistantMessage({
  content,
  searchQuery,
  subagentGroups,
}: Readonly<{
  content: string | ContentBlock[];
  searchQuery: string;
  subagentGroups?: SubagentGroup[];
}>) {
  const [expandedTools, toggleTool] = useExpandedState();

  // Build lookup for inline subagent rendering after their Task tool_use.
  // Must be called before early returns to satisfy Rules of Hooks.
  const subagentByToolId = useMemo(() => {
    const map = new Map<string, SubagentGroup>();
    for (const group of subagentGroups ?? []) {
      map.set(group.toolUseId, group);
    }
    return map;
  }, [subagentGroups]);

  if (typeof content === "string") {
    if (searchQuery.trim()) {
      return (
        <div className="whitespace-pre-wrap text-foreground/90 text-sm leading-relaxed">
          {highlightMatches(content, searchQuery)}
        </div>
      );
    }
    return (
      <div className="log-prose text-foreground/90 text-sm">
        <ReactMarkdown
          components={logMarkdownComponents}
          remarkPlugins={[remarkGfm, remarkBreaks]}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {content.map((block, idx) =>
        renderContentBlock(
          block,
          idx,
          searchQuery,
          expandedTools,
          toggleTool,
          subagentByToolId
        )
      )}
    </div>
  );
}

function renderContentBlock(
  block: ContentBlock,
  idx: number,
  searchQuery: string,
  expandedTools: Set<string>,
  toggleTool: (id: string) => void,
  subagentByToolId: Map<string, SubagentGroup>
): React.ReactElement | null {
  if (block.type === "text" && block.text) {
    const textKey = `text-${idx}`;
    if (searchQuery.trim()) {
      return (
        <div
          className="whitespace-pre-wrap text-foreground/90 text-sm leading-relaxed"
          key={textKey}
        >
          {highlightMatches(block.text, searchQuery)}
        </div>
      );
    }
    return (
      <div className="log-prose text-foreground/90 text-sm" key={textKey}>
        <ReactMarkdown
          components={logMarkdownComponents}
          remarkPlugins={[remarkGfm, remarkBreaks]}
        >
          {block.text}
        </ReactMarkdown>
      </div>
    );
  }

  if (block.type === "thinking" && block.thinking) {
    const id = `thinking-${idx}`;
    return (
      <CollapsibleBlock
        icon={Sparkles}
        id={id}
        isExpanded={expandedTools.has(id)}
        key={id}
        onToggle={toggleTool}
        title="Extended thinking..."
        variant="thinking"
      >
        {highlightMatches(block.thinking, searchQuery)}
      </CollapsibleBlock>
    );
  }

  if (block.type === "tool_use") {
    const id = block.id || `tool-${idx}`;
    const subagent = block.id ? subagentByToolId.get(block.id) : undefined;
    return (
      <div className="space-y-2.5" key={id}>
        <CollapsibleBlock
          icon={Wrench}
          id={id}
          isExpanded={expandedTools.has(id)}
          onToggle={toggleTool}
          title={highlightMatches(block.name || "Tool", searchQuery)}
          variant="tool"
        >
          {highlightMatches(JSON.stringify(block.input, null, 2), searchQuery)}
        </CollapsibleBlock>
        {subagent && (
          <SubagentBlock
            agentType={subagent.agentType}
            content={subagent.content}
            description={subagent.description}
            searchQuery={searchQuery}
          />
        )}
      </div>
    );
  }

  if (block.type === "tool_result") {
    const id = block.id || `result-${idx}`;
    const resultContent = getToolResultText(block);
    if (!resultContent) {
      return null;
    }

    return (
      <CollapsibleBlock
        icon={Terminal}
        id={id}
        isExpanded={expandedTools.has(id)}
        key={id}
        onToggle={toggleTool}
        title={block.is_error ? "Error" : "Result"}
        variant={block.is_error ? "error" : "result"}
      >
        {highlightMatches(resultContent, searchQuery)}
      </CollapsibleBlock>
    );
  }

  return null;
}

/**
 * Component to render tool results (which come as "user" type messages)
 */
function ToolResultMessage({
  content,
  searchQuery,
}: Readonly<{
  content: ContentBlock[];
  searchQuery: string;
}>) {
  const [expandedTools, toggleTool] = useExpandedState();

  return (
    <div className="space-y-2.5">
      {content.map((block, idx) => {
        if (block.type === "tool_result") {
          const id = block.id || `result-${idx}`;
          const resultContent = getToolResultText(block);
          if (!resultContent) {
            return null;
          }

          return (
            <CollapsibleBlock
              icon={Terminal}
              id={id}
              isExpanded={expandedTools.has(id)}
              key={id}
              onToggle={toggleTool}
              title={block.is_error ? "Error" : "Result"}
              variant={block.is_error ? "error" : "result"}
            >
              {highlightMatches(resultContent, searchQuery)}
            </CollapsibleBlock>
          );
        }
        return null;
      })}
    </div>
  );
}

/**
 * Single grouped log entry component - chat bubble layout.
 * Works with GroupedEntry where consecutive assistant blocks are merged.
 */
function LogEntryRow({
  entry,
  searchQuery,
}: Readonly<{ entry: GroupedEntry; searchQuery: string }>) {
  if (entry.type === "file-history-snapshot") {
    return null;
  }

  const isUser = entry.type === "user";
  const isAssistant = entry.type === "assistant";
  const isSystem =
    entry.type === "system" ||
    entry.type === "progress" ||
    entry.type === "queue-operation";

  // Check if this "user" message is actually a tool result
  const isToolResult = isUser && hasToolResult(entry.content);

  if (isAssistant && entry.content.length === 0) {
    return null;
  }

  // System/progress messages - compact centered style
  if (isSystem) {
    const isResult = entry.data?.type === "result";
    const label =
      entry.data?.subtype ||
      entry.data?.hookName ||
      entry.data?.hookEvent ||
      "System event";
    const metadata: string[] = [];
    if (isResult && typeof entry.data?.durationMs === "number") {
      metadata.push(`${entry.data.durationMs}ms`);
    }
    if (isResult && typeof entry.data?.numTurns === "number") {
      metadata.push(
        `${entry.data.numTurns} turn${entry.data.numTurns === 1 ? "" : "s"}`
      );
    }
    if (
      isResult &&
      typeof entry.data?.totalCostUsd === "number" &&
      entry.data.totalCostUsd >= 0
    ) {
      metadata.push(formatCurrency(entry.data.totalCostUsd));
    }
    return (
      <div className="space-y-1 px-5 py-2">
        <div className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground/50">
          <Activity className="size-3" />
          <span className="font-mono">
            {highlightMatches(label, searchQuery)}
          </span>
          {metadata.length > 0 && (
            <span className="font-mono text-muted-foreground/40">
              {metadata.join(" • ")}
            </span>
          )}
          {entry.timestamp && (
            <span className="font-mono tabular-nums">
              {formatTimestamp(entry.timestamp)}
            </span>
          )}
        </div>
        {isResult && entry.data?.resultText?.trim() && (
          <div className="mx-auto max-w-[90%] whitespace-pre-wrap rounded-lg border border-border/50 bg-muted/30 px-3 py-2 font-mono text-muted-foreground text-xs">
            {highlightMatches(entry.data.resultText, searchQuery)}
          </div>
        )}
      </div>
    );
  }

  // Tool results - render as part of assistant flow (left aligned, in bubble)
  if (isToolResult) {
    return (
      <div className="px-5 py-2">
        <div className="ml-8 max-w-[90%] rounded-2xl rounded-tl-sm border border-border/60 bg-muted/60 px-4 py-2.5 dark:border-border/40 dark:bg-muted/30">
          <ToolResultMessage
            content={entry.content}
            searchQuery={searchQuery}
          />
        </div>
      </div>
    );
  }

  // User messages - right aligned
  if (isUser) {
    const content = entry.message?.content ?? entry.content;
    return (
      <div className="flex justify-end px-5 py-3">
        <div className="flex max-w-[95%] flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-muted-foreground/50 tabular-nums">
              {entry.timestamp && formatTimestamp(entry.timestamp)}
            </span>
            <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
              You
            </span>
          </div>
          <div className="max-w-full overflow-x-auto rounded-2xl rounded-tr-sm border border-border/60 bg-muted/60 px-4 py-2.5 dark:border-border/40 dark:bg-muted/30">
            {content && (
              <UserMessage content={content} searchQuery={searchQuery} />
            )}
          </div>
        </div>
      </div>
    );
  }

  // Assistant messages - left aligned, with grouped content blocks
  return (
    <div className="px-5 py-3">
      <div className="flex max-w-[90%] flex-col gap-1">
        <div className="flex items-center gap-2">
          <div className="flex size-6 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
            <Bot className="size-3 text-primary" />
          </div>
          <span className="font-medium text-[11px] text-primary uppercase tracking-wide">
            Claude
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/50 tabular-nums">
            {entry.timestamp && formatTimestamp(entry.timestamp)}
          </span>
        </div>
        <div className="ml-8 rounded-2xl rounded-tl-sm border border-border/60 bg-muted/60 px-4 py-2.5 dark:border-border/40 dark:bg-muted/30">
          <AssistantMessage
            content={entry.content}
            searchQuery={searchQuery}
            subagentGroups={entry.subagentGroups}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Filter chip component with filter-specific colors
 */
function FilterChip({
  filter,
  currentFilter,
  onClick,
  count,
  icon: Icon,
  label,
}: Readonly<{
  filter: LogFilter;
  currentFilter: LogFilter;
  onClick: (filter: LogFilter) => void;
  count: number;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}>) {
  const isActive = currentFilter === filter;

  const activeStyles: Record<LogFilter, string> = {
    all: "bg-slate-600 dark:bg-slate-500 text-white",
    user: "bg-slate-600 dark:bg-slate-500 text-white",
    assistant: "bg-primary text-primary-foreground",
    tool: "bg-slate-600 dark:bg-slate-500 text-white",
    subagent: "bg-orange-500 dark:bg-orange-500 text-white",
    progress: "bg-slate-500 dark:bg-slate-600 text-white",
  };

  return (
    <button
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium text-xs transition-all duration-200",
        isActive
          ? cn(activeStyles[filter], "shadow-sm")
          : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
      onClick={() => onClick(filter)}
      type="button"
    >
      <Icon className="size-3" />
      <span>{label}</span>
      <span
        className={cn(
          "ml-0.5 rounded-full px-1.5 py-0.5 font-semibold text-[10px] tabular-nums",
          isActive
            ? "bg-white/20 text-inherit"
            : "bg-background text-muted-foreground"
        )}
      >
        {count}
      </span>
    </button>
  );
}

/**
 * Enhanced JSONL log viewer with search and filtering
 */
export function JsonlLogViewer({
  lines,
  className,
}: Readonly<JsonlLogViewerProps>) {
  const [filter, setFilter] = useState<LogFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAutoScrolling = useRef(false);

  // Parse individual lines, then group consecutive assistant entries
  const grouped = useMemo(() => {
    const parsed = lines
      .map(parseLogLine)
      .filter((entry): entry is LogEntry => entry !== null);
    return groupEntries(parsed);
  }, [lines]);

  const counts = useMemo(() => {
    const hasToolUseIncludingSubagents = (e: GroupedEntry) =>
      hasToolUse(e.content) ||
      (e.subagentGroups?.some((g) => hasToolUse(g.content)) ?? false);

    const toolResultEntries = grouped.filter(
      (e) => e.type === "user" && hasToolResult(e.content)
    );
    const toolUseEntries = grouped.filter(
      (e) => e.type === "assistant" && hasToolUseIncludingSubagents(e)
    );
    const userCount = grouped.filter(
      (e) => e.type === "user" && !hasToolResult(e.content)
    ).length;
    const assistantCount = grouped.filter((e) => e.type === "assistant").length;
    const toolCount = toolUseEntries.length + toolResultEntries.length;
    const subagentCount = grouped.filter(
      (e) => (e.subagentGroups?.length ?? 0) > 0
    ).length;
    const progressCount = grouped.filter(
      (e) =>
        e.type === "system" ||
        e.type === "progress" ||
        e.type === "queue-operation"
    ).length;
    return {
      all: grouped.length,
      user: userCount,
      assistant: assistantCount,
      tool: toolCount,
      subagent: subagentCount,
      progress: progressCount,
    };
  }, [grouped]);

  const filteredEntries = useMemo(() => {
    return grouped.filter(
      (entry) =>
        matchesFilter(entry, filter) && matchesSearch(entry, searchQuery)
    );
  }, [grouped, filter, searchQuery]);

  useEffect(() => {
    if (containerRef.current && !showScrollToBottom) {
      isAutoScrolling.current = true;
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setTimeout(() => {
        isAutoScrolling.current = false;
      }, 100);
    }
  }, [showScrollToBottom]);

  const handleScroll = useCallback(() => {
    if (isAutoScrolling.current || !containerRef.current) {
      return;
    }
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
    setShowScrollToBottom(!isNearBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      isAutoScrolling.current = true;
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: "smooth",
      });
      setShowScrollToBottom(false);
      setTimeout(() => {
        isAutoScrolling.current = false;
      }, 500);
    }
  }, []);

  return (
    <div className={cn("flex h-full flex-col bg-background", className)}>
      {/* Header */}
      <div className="shrink-0 space-y-3 border-b bg-muted/20 p-4">
        {/* Search */}
        <div className="relative">
          <Search className="absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground/60" />
          <input
            className={cn(
              "h-10 w-full rounded-lg border bg-background/80 pr-10 pl-10 backdrop-blur-sm",
              "text-sm placeholder:text-muted-foreground/50",
              "focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/30",
              "transition-all duration-200"
            )}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversation..."
            type="text"
            value={searchQuery}
          />
          {searchQuery && (
            <button
              className="absolute top-1/2 right-3 flex size-5 -translate-y-1/2 items-center justify-center rounded-full bg-muted transition-colors hover:bg-muted-foreground/20"
              onClick={() => setSearchQuery("")}
              type="button"
            >
              <X className="size-3 text-muted-foreground" />
            </button>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip
            count={counts.all}
            currentFilter={filter}
            filter="all"
            icon={Terminal}
            label="All"
            onClick={setFilter}
          />
          <FilterChip
            count={counts.user}
            currentFilter={filter}
            filter="user"
            icon={User}
            label="User"
            onClick={setFilter}
          />
          <FilterChip
            count={counts.assistant}
            currentFilter={filter}
            filter="assistant"
            icon={Bot}
            label="Claude"
            onClick={setFilter}
          />
          <FilterChip
            count={counts.tool}
            currentFilter={filter}
            filter="tool"
            icon={Wrench}
            label="Tools"
            onClick={setFilter}
          />
          <FilterChip
            count={counts.subagent}
            currentFilter={filter}
            filter="subagent"
            icon={Workflow}
            label="Subagents"
            onClick={setFilter}
          />
          <FilterChip
            count={counts.progress}
            currentFilter={filter}
            filter="progress"
            icon={Activity}
            label="System"
            onClick={setFilter}
          />
        </div>
      </div>

      {/* Log entries */}
      <div
        className="log-scrollbar min-h-0 flex-1 overflow-auto"
        onScroll={handleScroll}
        ref={containerRef}
      >
        {filteredEntries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center py-12 text-muted-foreground">
            <Terminal className="mb-3 size-10 opacity-30" />
            <p className="font-medium text-sm">
              {searchQuery ? "No matching entries" : "No log entries yet"}
            </p>
            {searchQuery && (
              <button
                className="mt-2 text-primary text-xs hover:underline"
                onClick={() => setSearchQuery("")}
                type="button"
              >
                Clear search
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-border/30">
            {filteredEntries.map((entry) => (
              <LogEntryRow
                entry={entry}
                key={entry.uuid}
                searchQuery={searchQuery}
              />
            ))}
          </div>
        )}
      </div>

      {/* Scroll to bottom FAB */}
      {showScrollToBottom && (
        <button
          className={cn(
            "absolute right-6 bottom-6 size-11 rounded-full",
            "bg-primary text-primary-foreground shadow-lg",
            "flex items-center justify-center",
            "hover:scale-105 hover:bg-primary/90 active:scale-95",
            "transition-all duration-200",
            "fade-in slide-in-from-bottom-4 animate-in duration-300"
          )}
          onClick={scrollToBottom}
          title="Scroll to bottom"
          type="button"
        >
          <ArrowDown className="size-5" />
        </button>
      )}
    </div>
  );
}

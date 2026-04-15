"use client";

import { cn } from "@repo/design-system/lib/utils";
import {
  ChevronRight,
  Sparkles,
  Terminal,
  Workflow,
  Wrench,
} from "lucide-react";
import { memo, useCallback, useState } from "react";
import type { ContentBlock } from "@/components/chat/types";
import { CollapsibleBlock } from "./CollapsibleBlock";

export type SubagentBlockProps = {
  description: string;
  /** e.g. "code:implementation-subagent" */
  agentType?: string;
  content: ContentBlock[];
  searchQuery?: string;
};

/**
 * Collapsible section that renders a subagent's work.
 * Shows as a compact header when collapsed, expandable to show full content.
 */
export const SubagentBlock = memo(function SubagentBlock({
  description,
  agentType,
  content,
  searchQuery = "",
}: Readonly<SubagentBlockProps>) {
  // Extract short name from "plugin:agent-name" → "agent-name"
  const agentLabel = agentType?.includes(":")
    ? agentType.split(":").pop()
    : agentType;
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const toggleTool = useCallback((id: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const blockCount = content.length;

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-orange-400/30 dark:border-orange-400/35">
      <button
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors",
          "bg-orange-400/5 hover:bg-orange-400/10 dark:bg-orange-400/10 dark:hover:bg-orange-400/15",
          "text-orange-700 dark:text-orange-300"
        )}
        onClick={toggleExpanded}
      >
        <span
          className="transition-transform duration-200"
          style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          <ChevronRight className="size-3.5" />
        </span>
        <Workflow className="size-3.5 shrink-0 opacity-70" />
        <div className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">
              {agentLabel || "Subagent"}
            </span>
            <span className="rounded-full bg-orange-400/15 px-1.5 py-0.5 font-semibold text-[10px] tabular-nums dark:bg-orange-400/20">
              {blockCount} {blockCount === 1 ? "step" : "steps"}
            </span>
          </div>
          <div className="truncate text-orange-600/60 text-xs dark:text-orange-300/50">
            {description}
          </div>
        </div>
      </button>
      <div
        className={cn(
          "grid transition-all duration-200 ease-out",
          isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className="space-y-2 bg-orange-400/[0.02] px-3 py-2 dark:bg-orange-400/[0.03]">
            {content.map((block, idx) => {
              if (block.type === "text" && block.text) {
                const text = block.text;
                const key = `sa-text-${idx}`;
                if (searchQuery.trim()) {
                  return (
                    <div
                      className="whitespace-pre-wrap text-foreground/80 text-xs leading-relaxed"
                      key={key}
                    >
                      {text}
                    </div>
                  );
                }
                return (
                  <div
                    className="whitespace-pre-wrap text-foreground/80 text-xs leading-relaxed"
                    key={key}
                  >
                    {text}
                  </div>
                );
              }

              if (block.type === "thinking" && block.thinking) {
                const id = `sa-thinking-${idx}`;
                return (
                  <CollapsibleBlock
                    icon={Sparkles}
                    id={id}
                    isExpanded={expandedTools.has(id)}
                    key={id}
                    onToggle={toggleTool}
                    title="Thinking..."
                    variant="thinking"
                  >
                    {block.thinking}
                  </CollapsibleBlock>
                );
              }

              if (block.type === "tool_use") {
                const id = block.id || `sa-tool-${idx}`;
                return (
                  <CollapsibleBlock
                    icon={Wrench}
                    id={id}
                    isExpanded={expandedTools.has(id)}
                    key={id}
                    onToggle={toggleTool}
                    title={block.name || "Tool"}
                    variant="tool"
                  >
                    {JSON.stringify(block.input, null, 2)}
                  </CollapsibleBlock>
                );
              }

              if (block.type === "tool_result") {
                const id = block.id || `sa-result-${idx}`;
                const resultContent = extractToolResultText(block.content);
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
                    {resultContent}
                  </CollapsibleBlock>
                );
              }

              return null;
            })}
          </div>
        </div>
      </div>
    </div>
  );
});

/**
 * Extract displayable text from a tool_result content field.
 * Handles string content, array of text blocks, and image blocks.
 * Returns empty string when there's nothing meaningful to display.
 */
export function extractToolResultText(
  content: string | unknown[] | undefined
): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((c) => {
      if (typeof c === "string") {
        return c;
      }
      if (
        typeof c === "object" &&
        c !== null &&
        "text" in c &&
        typeof c.text === "string"
      ) {
        return c.text;
      }
      if (
        typeof c === "object" &&
        c !== null &&
        "type" in c &&
        c.type === "image"
      ) {
        return "[Image]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

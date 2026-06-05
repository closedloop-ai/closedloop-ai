"use client";

import { FileText, Sparkles } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { chatMarkdownComponents } from "@/lib/engineer/chat-markdown";
import { parseLearningsUsed } from "@/lib/engineer/chat-utils";
import { CollapsibleBlock } from "./CollapsibleBlock";
import { CollapsibleBlockGroup } from "./CollapsibleBlockGroup";
import { LearningsUsedDialog } from "./LearningsUsedDialog";
import type { ContentBlock } from "./types";

type MessageContentProps = {
  content: string;
  blocks?: ContentBlock[];
  isStreaming?: boolean;
  markdownComponents?: Components;
};

/**
 * Shared component for rendering assistant message content with blocks and markdown.
 * Handles tool_use, tool_result, and thinking blocks with CollapsibleBlock,
 * and renders text content as markdown.
 */
export function MessageContent({
  content,
  blocks,
  isStreaming = false,
  markdownComponents = chatMarkdownComponents,
}: Readonly<MessageContentProps>) {
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set());

  const toggleBlock = useCallback((id: string) => {
    setExpandedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Separate thinking blocks from tool blocks (tool_use and tool_result)
  const { thinkingBlocks, toolBlocks } = useMemo(() => {
    const all = blocks?.filter((b) => b.type !== "text") || [];
    return {
      thinkingBlocks: all.filter((b) => b.type === "thinking"),
      toolBlocks: all.filter((b) => b.type !== "thinking"),
    };
  }, [blocks]);

  // Parse learnings, extract <context> blocks, and strip both from content
  const { contextBlocks, textContent, learnings } = useMemo(() => {
    // Parse and strip <learnings-used> blocks
    const { cleanContent, learnings: parsed } = parseLearningsUsed(content);
    const extracted: { id: string; title: string; body: string }[] = [];
    let remaining = cleanContent;
    const contextRegex = /<context>([\s\S]*?)<\/context>/g;
    let idx = 0;
    for (const match of remaining.matchAll(contextRegex)) {
      const body = match[1].trim();
      // Extract title from first heading or first line
      const headingMatch = /^#+\s+(.+)$/m.exec(body);
      const title = headingMatch ? headingMatch[1].slice(0, 60) : "Context";
      extracted.push({ id: `context-${idx}`, title, body });
      idx++;
    }
    if (extracted.length > 0) {
      remaining = remaining.replaceAll(contextRegex, "");
    }
    return {
      contextBlocks: extracted,
      textContent: remaining.trim(),
      learnings: parsed,
    };
  }, [content]);

  return (
    <div className="prose prose-sm dark:prose-invert prose-headings:my-2 prose-li:my-0.5 prose-ol:my-1.5 prose-p:my-1.5 prose-ul:my-1.5 max-w-none">
      {/* Render context blocks as collapsed sections */}
      {contextBlocks.length > 0 && (
        <div className="not-prose mb-2 space-y-2">
          {contextBlocks.map((ctx) => (
            <CollapsibleBlock
              icon={FileText}
              id={ctx.id}
              isExpanded={expandedBlocks.has(ctx.id)}
              key={ctx.id}
              onToggle={toggleBlock}
              title={ctx.title}
              variant="context"
            >
              {ctx.body}
            </CollapsibleBlock>
          ))}
        </div>
      )}

      {/* Render all thinking blocks merged into a single collapsible */}
      {thinkingBlocks.length > 0 && (
        <div className="not-prose mb-2 space-y-2">
          <CollapsibleBlock
            icon={Sparkles}
            id="thinking-merged"
            isExpanded={expandedBlocks.has("thinking-merged")}
            onToggle={toggleBlock}
            title="Extended thinking..."
            variant="thinking"
          >
            {thinkingBlocks.map((b) => b.thinking || "").join("\n\n")}
          </CollapsibleBlock>
        </div>
      )}

      {/* Render tool blocks grouped with collapsible previous operations */}
      {toolBlocks.length > 0 && (
        <div className="not-prose mb-2 space-y-2">
          <CollapsibleBlockGroup
            blocks={toolBlocks}
            expandedBlocks={expandedBlocks}
            onToggleBlock={toggleBlock}
          />
        </div>
      )}
      {/* Render text content (context blocks stripped) */}
      {textContent && (
        <ReactMarkdown
          components={markdownComponents}
          remarkPlugins={[remarkGfm]}
        >
          {textContent}
        </ReactMarkdown>
      )}
      {isStreaming && (
        <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-primary" />
      )}
      {!isStreaming && learnings.length > 0 && (
        <div className="not-prose mt-2">
          <LearningsUsedDialog learnings={learnings} />
        </div>
      )}
    </div>
  );
}

"use client";

import { FileText } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { extractContextBlocks } from "@/lib/engineer/chat-utils";
import { CollapsibleBlock } from "./CollapsibleBlock";

type UserMessageContentProps = {
  content: string;
  /** Optional custom renderer for the remaining text (after context blocks are extracted). */
  children?: (text: string) => React.ReactNode;
};

/**
 * Shared user message renderer that extracts <context> blocks and displays them
 * as collapsible sections. Used by SymphonyChat, CommentChat, and TicketChatDialog.
 */
export function UserMessageContent({
  content,
  children,
}: Readonly<UserMessageContentProps>) {
  const [expandedContexts, setExpandedContexts] = useState<Set<string>>(
    new Set()
  );

  const toggleContext = useCallback((id: string) => {
    setExpandedContexts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const { blocks, remaining } = useMemo(
    () => extractContextBlocks(content),
    [content]
  );

  return (
    <div className="font-mono text-[13px]">
      {blocks.length > 0 && (
        <div className="not-prose mb-2 space-y-2">
          {blocks.map((ctx) => (
            <CollapsibleBlock
              icon={FileText}
              id={ctx.id}
              isExpanded={expandedContexts.has(ctx.id)}
              key={ctx.id}
              onToggle={toggleContext}
              title={ctx.title}
              variant="context"
            >
              {ctx.body}
            </CollapsibleBlock>
          ))}
        </div>
      )}
      {remaining &&
        (children ? (
          children(remaining)
        ) : (
          <div className="whitespace-pre-wrap break-words">{remaining}</div>
        ))}
    </div>
  );
}

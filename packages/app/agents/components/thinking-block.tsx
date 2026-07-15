"use client";

import { MarkdownContent } from "@repo/design-system/components/ui/primitives/markdown-content";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

type ThinkingBlockProps = {
  text: string;
  defaultExpanded?: boolean;
};

export function ThinkingBlock({
  text,
  defaultExpanded = false,
}: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!text) {
    return null;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-amber-500/20 bg-amber-500/5">
      <button
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-amber-500/10"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 text-amber-500/60" />
        ) : (
          <ChevronRight className="size-3.5 text-amber-500/60" />
        )}
        <Brain className="size-3.5 text-amber-400/80" />
        <span className="font-medium text-amber-200/90 text-xs">Thinking</span>
        {expanded ? null : (
          <span className="ml-auto font-mono text-[10px] text-amber-300/40">
            {text.length.toLocaleString()} chars
          </span>
        )}
      </button>
      {expanded ? (
        <div className="border-amber-500/10 border-t px-3 py-2 text-amber-100/80">
          <MarkdownContent dense text={text} />
        </div>
      ) : null}
    </div>
  );
}

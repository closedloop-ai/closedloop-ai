"use client";

import { stringifyJsonValue } from "@repo/app/agents/lib/conversation-transforms";
import type { ConversationContentBlock } from "@repo/design-system/components/ui/types";
import { CheckCircle2, ChevronDown, ChevronRight, XCircle } from "lucide-react";
import { useState } from "react";

type ToolResultBlockProps = {
  result: Extract<ConversationContentBlock, { type: "tool_result" }>;
  defaultExpanded?: boolean;
};

export function ToolResultBlock({
  result,
  defaultExpanded = false,
}: ToolResultBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const text = stringifyJsonValue(result.output);
  const lines = text.split("\n").length;
  const tone = result.isError
    ? "border-red-500/30 bg-red-500/5 text-red-200"
    : "border-emerald-500/20 bg-emerald-500/5 text-emerald-200";

  return (
    <div className={`rounded-md border ${tone}`}>
      <button
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-medium text-[11px] transition-colors hover:bg-white/5"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
        {result.isError ? (
          <XCircle className="size-3 shrink-0" />
        ) : (
          <CheckCircle2 className="size-3 shrink-0" />
        )}
        <span>Tool result</span>
        <span className="text-[10px] opacity-70">
          ({lines} {lines === 1 ? "line" : "lines"})
        </span>
      </button>
      {expanded ? (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-current/20 border-t px-3 py-2 font-mono text-[11px] opacity-90">
          {text}
        </pre>
      ) : null}
    </div>
  );
}

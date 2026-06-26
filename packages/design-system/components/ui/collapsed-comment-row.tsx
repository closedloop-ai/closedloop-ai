"use client";

import { CheckIcon, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

type CollapsedCommentRowProps = {
  author: string;
  title: string | null;
  onExpand: () => void;
  avatar: ReactNode;
  statusLabel?: string;
};

export function CollapsedCommentRow({
  author,
  title,
  onExpand,
  avatar,
  statusLabel = "Comment resolved",
}: Readonly<CollapsedCommentRowProps>) {
  return (
    <button
      className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-accent/50"
      onClick={onExpand}
      type="button"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
        <CheckIcon aria-hidden className="h-3 w-3" />
      </span>
      {avatar}
      <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
        <span className="font-medium text-foreground">{statusLabel}</span> ·{" "}
        <span className="font-medium text-foreground">{author}</span>
        {title ? ` · ${title}` : ""}
      </span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

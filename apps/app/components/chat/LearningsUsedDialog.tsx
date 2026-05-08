"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/design-system/components/ui/dialog";
import { cn } from "@repo/design-system/lib/utils";
import { BookOpen } from "lucide-react";
import type { LearningUsed } from "@/lib/chat/chat-utils";

const CATEGORY_COLORS: Record<string, string> = {
  mistake: "bg-red-500/15 text-red-700 dark:text-red-400",
  pattern: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  convention: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  insight: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
};

const SOURCE_LABELS: Record<string, string> = {
  "org-patterns": "Org Patterns",
  "claude.md": "CLAUDE.md",
};

type LearningsUsedDialogProps = {
  learnings: LearningUsed[];
};

/**
 * Chip + dialog for displaying which learnings were applied to a response.
 * Renders a small "Learnings" chip that opens a dialog with details.
 */
export function LearningsUsedDialog({
  learnings,
}: Readonly<LearningsUsedDialogProps>) {
  if (learnings.length === 0) {
    return null;
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium text-[11px]",
            "border border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-400",
            "cursor-pointer transition-colors hover:border-violet-500/30 hover:bg-violet-500/20"
          )}
          type="button"
        >
          <BookOpen className="size-3" />
          Learnings
          <span className="inline-flex size-4 items-center justify-center rounded-full bg-violet-500/20 font-bold text-[10px]">
            {learnings.length}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">Learnings Applied</DialogTitle>
          <DialogDescription>
            {learnings.length} organization learning
            {learnings.length === 1 ? "" : "s"} influenced this response.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-2 space-y-3">
          {learnings.map((learning) => (
            <LearningCard key={learning.id} learning={learning} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LearningCard({ learning }: Readonly<{ learning: LearningUsed }>) {
  const categoryColor =
    CATEGORY_COLORS[learning.category] ?? "bg-muted text-muted-foreground";
  const sourceLabel = SOURCE_LABELS[learning.source] ?? learning.source;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-bold font-mono text-foreground/80 text-xs">
          {learning.id}
        </code>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-medium text-[10px]",
            categoryColor
          )}
        >
          {learning.category}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground">
          {sourceLabel}
        </span>
        {learning.confidence && (
          <span className="font-mono text-[10px] text-muted-foreground">
            {learning.confidence}
          </span>
        )}
      </div>
      <p className="text-foreground/90 text-sm leading-relaxed">
        {learning.summary}
      </p>
      {learning.context && learning.context.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {learning.context.map((tag) => (
            <span
              className="rounded bg-foreground/5 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              key={tag}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

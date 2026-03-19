"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { cn } from "@repo/design-system/lib/utils";
import {
  ChevronDown,
  ChevronRight,
  FileDiff,
  GitPullRequestArrow,
} from "lucide-react";
import { useState } from "react";
import type { StubChangedFile } from "../types";

type CommittedChangesSectionProps = {
  files: StubChangedFile[];
  onSelectFile: (path: string) => void;
  selectedPath: string | null;
  /** When true, "Create PR" is disabled (PR already exists). */
  hasPr?: boolean;
};

/**
 * Committed Changes section. Collapsible header with chevron; header has title, file count, Create PR (disabled when hasPr).
 */
export function CommittedChangesSection({
  files,
  onSelectFile,
  selectedPath,
  hasPr = true,
}: Readonly<CommittedChangesSectionProps>) {
  const [expanded, setExpanded] = useState(true);
  const fileCountLabel = `${files.length} ${files.length === 1 ? "File" : "Files"}`;
  return (
    <Collapsible onOpenChange={setExpanded} open={expanded}>
      <section className="flex flex-col">
        <CollapsibleTrigger asChild>
          <div className="flex h-12 cursor-pointer items-center justify-between gap-3 border-border border-b py-3 outline-none hover:bg-accent/30 [&[data-state=open]]:bg-transparent">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 font-semibold text-base text-foreground">
                Committed Changes
              </span>
              {expanded ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-muted-foreground text-sm">
                {fileCountLabel}
              </span>
              <Button
                className="h-8 shrink-0 px-3 opacity-40"
                disabled={hasPr}
                onClick={(e) => e.stopPropagation()}
                size="sm"
                type="button"
                variant="secondary"
              >
                <GitPullRequestArrow className="mr-1.5 h-4 w-4" />
                Create PR
              </Button>
            </div>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-border border-t">
            {files.map((file) => {
              const isSelected = selectedPath === file.path;
              return (
                <button
                  className={cn(
                    "flex h-11 w-full items-center gap-4 border-border border-b px-4 text-left",
                    "cursor-pointer bg-background transition-colors hover:bg-accent/50",
                    isSelected && "border-l-4 border-l-primary bg-accent"
                  )}
                  key={file.path}
                  onClick={() => onSelectFile(file.path)}
                  type="button"
                >
                  <FileDiff className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-left font-medium text-foreground text-sm">
                    {file.path}
                  </span>
                </button>
              );
            })}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

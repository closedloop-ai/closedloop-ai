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
  CircleDot,
  CirclePlus,
  FileX,
  GitCommitHorizontal,
} from "lucide-react";
import { useState } from "react";
import type { StubChangedFile } from "../types";

type LocalChangesSectionProps = {
  files: StubChangedFile[];
  onSelectFile: (path: string) => void;
  selectedPath: string | null;
};

function StatusIcon({ status }: { status: StubChangedFile["status"] }) {
  const className = "h-4 w-4 shrink-0";
  if (status === "added") {
    return <CirclePlus className={cn(className, "text-success")} />;
  }
  if (status === "removed") {
    return <FileX className={cn(className, "text-destructive")} />;
  }
  return <CircleDot className={cn(className, "text-warning")} />;
}

/**
 * Local Changes section. Collapsible header with chevron; header has title, file count, Commit & push.
 */
export function LocalChangesSection({
  files,
  onSelectFile,
  selectedPath,
}: Readonly<LocalChangesSectionProps>) {
  const [expanded, setExpanded] = useState(true);
  if (files.length === 0) {
    return null;
  }

  const fileCountLabel = `${files.length} ${files.length === 1 ? "File" : "Files"}`;
  return (
    <Collapsible onOpenChange={setExpanded} open={expanded}>
      <section className="flex flex-col">
        <CollapsibleTrigger asChild>
          <div className="flex h-12 cursor-pointer items-center justify-between gap-3 border-border border-b py-3 outline-none hover:bg-accent/30 [&[data-state=open]]:bg-transparent">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 font-semibold text-base text-foreground">
                Local Changes
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
                className="h-8 px-3"
                onClick={(e) => e.stopPropagation()}
                size="sm"
              >
                <GitCommitHorizontal className="mr-1.5 h-4 w-4" />
                Commit & push
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
                  <StatusIcon status={file.status} />
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

"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { cn } from "@repo/design-system/lib/utils";
import { ChevronDown, ChevronRight, FileDiff } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { type BranchViewFile, buildFileId, type FileSection } from "../types";

type ChangesSectionProps = {
  title: string;
  files: BranchViewFile[];
  section: FileSection;
  onSelectFile: (path: string) => void;
  selectedFileId: string | null;
  actionButton: ReactNode;
  renderFileIcon?: (file: BranchViewFile) => ReactNode;
};

function DefaultFileIcon() {
  return <FileDiff className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

export function ChangesSection({
  title,
  files,
  section,
  onSelectFile,
  selectedFileId,
  actionButton,
  renderFileIcon,
}: Readonly<ChangesSectionProps>) {
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
                {title}
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
              {/* biome-ignore lint/a11y/noStaticElementInteractions: stop propagation so button click doesn't toggle collapse */}
              {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: wrapping interactive actionButton */}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: wrapping interactive actionButton */}
              <div onClick={(e) => e.stopPropagation()}>{actionButton}</div>
            </div>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-border border-t">
            {files.map((file) => {
              const fileId = buildFileId(section, file.path);
              const isSelected = selectedFileId === fileId;
              return (
                <button
                  className={cn(
                    "flex h-11 w-full items-center gap-4 border-border border-b px-4 text-left",
                    "cursor-pointer bg-background transition-colors hover:bg-accent/50",
                    isSelected && "border-l-4 border-l-primary bg-accent"
                  )}
                  key={fileId}
                  onClick={() => onSelectFile(file.path)}
                  type="button"
                >
                  {renderFileIcon ? renderFileIcon(file) : <DefaultFileIcon />}
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

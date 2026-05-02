"use client";

import { FileChangeStatus } from "@repo/api/src/types/branch-view";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { ScrollArea } from "@repo/design-system/components/ui/scroll-area";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useTheme } from "next-themes";
import type { ComponentType } from "react";
import ReactDiffViewerBase, {
  DiffMethod,
  type ReactDiffViewerProps,
} from "react-diff-viewer-continued";
import { useBranchViewFileDiff } from "@/hooks/queries/use-branch-view";
import { branchDiffViewerStyles } from "@/lib/diff-viewer-theme";
import { type ChangedFileEntry, FileSection } from "../types";

const ReactDiffViewer =
  ReactDiffViewerBase as unknown as ComponentType<ReactDiffViewerProps>;

function statusLabel(status: ChangedFileEntry["file"]["status"]): string {
  if (status === FileChangeStatus.Added) {
    return "Added";
  }
  if (status === FileChangeStatus.Removed) {
    return "Removed";
  }
  if (status === FileChangeStatus.Renamed) {
    return "Renamed";
  }
  return "Modified";
}

type BranchDiffViewProps = {
  allFiles: ChangedFileEntry[];
  externalLinkId: string;
  onClose: () => void;
  onSelectFile: (fileId: string) => void;
  selectedFileId: string;
};

export function BranchDiffView({
  allFiles,
  externalLinkId,
  onClose,
  onSelectFile,
  selectedFileId,
}: Readonly<BranchDiffViewProps>) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const currentIndex = allFiles.findIndex((f) => f.fileId === selectedFileId);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const currentEntry = allFiles[safeIndex];
  const total = allFiles.length;
  const hasPrev = safeIndex > 0;
  const hasNext = safeIndex < total - 1;
  const prevEntry = hasPrev ? allFiles[safeIndex - 1] : null;
  const nextEntry = hasNext ? allFiles[safeIndex + 1] : null;

  // Only fetch diff from API for committed files
  const isCommitted = currentEntry?.section === FileSection.Committed;
  const filePath = isCommitted ? (currentEntry?.file.path ?? null) : null;
  const previousPath = isCommitted
    ? (currentEntry?.file.previousPath ?? undefined)
    : undefined;

  const {
    data: diffData,
    isLoading: isDiffLoading,
    error: diffError,
  } = useBranchViewFileDiff(externalLinkId, filePath, previousPath);

  function handleCopyPath() {
    if (!currentEntry) {
      return;
    }
    navigator.clipboard.writeText(currentEntry.file.path).catch(() => {});
  }

  if (!currentEntry) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground text-sm">
        No file selected
      </div>
    );
  }

  const { file } = currentEntry;
  const additions = file.additions ?? 0;
  const deletions = file.deletions ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Back nav */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-border border-b px-6 py-2.5">
        <Button
          className="bg-transparent dark:bg-transparent"
          onClick={onClose}
          size="sm"
          variant="outline"
        >
          <ChevronLeft className="mr-1.5 h-4 w-4" />
          Back
        </Button>
        <div className="flex items-center gap-1">
          <Button
            aria-label="Previous file"
            className="bg-transparent dark:bg-transparent"
            disabled={!hasPrev}
            onClick={() => prevEntry && onSelectFile(prevEntry.fileId)}
            size="icon-sm"
            variant="outline"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[4rem] text-center font-medium text-muted-foreground text-sm">
            {safeIndex + 1} / {total}
          </span>
          <Button
            aria-label="Next file"
            className="bg-transparent dark:bg-transparent"
            disabled={!hasNext}
            onClick={() => nextEntry && onSelectFile(nextEntry.fileId)}
            size="icon-sm"
            variant="outline"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* File header */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-border border-b px-6 py-2.5">
        <span className="min-w-0 truncate font-mono text-foreground text-sm">
          {file.path}
        </span>
        <Badge variant="secondary">{statusLabel(file.status)}</Badge>
        <div className="flex items-center gap-2 font-mono font-semibold text-sm">
          {additions > 0 ? (
            <span className="text-success">+{additions}</span>
          ) : null}
          {deletions > 0 ? (
            <span className="text-destructive">-{deletions}</span>
          ) : null}
        </div>
        <div className="min-w-0 flex-1" />
        <Button
          className="bg-transparent dark:bg-transparent"
          size="sm"
          variant="outline"
        >
          View Raw
        </Button>
        <Button
          className="bg-transparent dark:bg-transparent"
          onClick={handleCopyPath}
          size="sm"
          variant="outline"
        >
          Copy Path
        </Button>
      </div>

      {/* Diff content */}
      <div className="min-h-0 flex-1 overflow-hidden border-border">
        {isDiffLoading && (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {!isDiffLoading && diffError && (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            Failed to load diff
          </div>
        )}
        {!(isDiffLoading || diffError) && diffData?.isBinary && (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            Binary file not shown
          </div>
        )}
        {!(isDiffLoading || diffError || diffData?.isBinary) && (
          <ScrollArea className="h-full">
            <ReactDiffViewer
              compareMethod={DiffMethod.WORDS}
              hideLineNumbers={false}
              newValue={diffData?.newContent ?? ""}
              oldValue={diffData?.oldContent ?? ""}
              splitView={true}
              styles={branchDiffViewerStyles}
              useDarkTheme={isDark}
            />
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { ScrollArea } from "@repo/design-system/components/ui/scroll-area";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTheme } from "next-themes";
import type { ComponentType } from "react";
import ReactDiffViewerBase, {
  DiffMethod,
  type ReactDiffViewerProps,
} from "react-diff-viewer-continued";
import type { StubChangedFile } from "../types";

const ReactDiffViewer =
  ReactDiffViewerBase as unknown as ComponentType<ReactDiffViewerProps>;

/** Stub old/new content for a file - replace with real diff when wiring API. */
const STUB_OLD = `export function scheduleNotification(item: TimeItem) {
  const window = getTimeWindow(item);
  if (!window.isActive) return;
  queue.push(item);
  processQueue();
}
`;

const STUB_NEW = `export function scheduleNotification(item: TimeItem) {
  const window = getTimeWindow(item);
  if (!window.isActive) return;
  queue.push(item);
  processQueue();
  logger.debug("Scheduled", { itemId: item.id });
}
`;

function statusLabel(status: StubChangedFile["status"]): string {
  if (status === "added") {
    return "Added";
  }
  if (status === "removed") {
    return "Removed";
  }
  return "Modified";
}

type BranchDiffViewProps = {
  allFiles: StubChangedFile[];
  onClose: () => void;
  onSelectFile: (path: string) => void;
  selectedFilePath: string;
};

export function BranchDiffView({
  allFiles,
  onClose,
  onSelectFile,
  selectedFilePath,
}: Readonly<BranchDiffViewProps>) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const currentIndex = allFiles.findIndex((f) => f.path === selectedFilePath);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const currentFile = allFiles[safeIndex];
  const total = allFiles.length;
  const hasPrev = safeIndex > 0;
  const hasNext = safeIndex < total - 1;
  const prevFile = hasPrev ? allFiles[safeIndex - 1] : null;
  const nextFile = hasNext ? allFiles[safeIndex + 1] : null;

  function handleCopyPath() {
    if (!currentFile) {
      return;
    }
    navigator.clipboard.writeText(currentFile.path).catch(() => {});
  }

  if (!currentFile) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground text-sm">
        No file selected
      </div>
    );
  }

  const additions = currentFile.additions ?? 0;
  const deletions = currentFile.deletions ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Back nav — stroke-only buttons per design */}
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
            onClick={() => prevFile && onSelectFile(prevFile.path)}
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
            onClick={() => nextFile && onSelectFile(nextFile.path)}
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
          {currentFile.path}
        </span>
        <Badge variant="secondary">{statusLabel(currentFile.status)}</Badge>
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
        <ScrollArea className="h-full">
          <ReactDiffViewer
            compareMethod={DiffMethod.WORDS}
            hideLineNumbers={false}
            newValue={STUB_NEW}
            oldValue={STUB_OLD}
            splitView={true}
            styles={branchMockDiffViewerStyles}
            useDarkTheme={isDark}
          />
        </ScrollArea>
      </div>
    </div>
  );
}

/** Mock-only react-diff-viewer theme; engineers can replace when wiring real diffs. */
const branchMockDiffVars = {
  diffViewerBackground: "var(--background)",
  diffViewerColor: "var(--foreground)",
  addedBackground: "color-mix(in oklch, var(--success) 14%, transparent)",
  addedColor: "var(--foreground)",
  removedBackground: "color-mix(in oklch, var(--destructive) 14%, transparent)",
  removedColor: "var(--foreground)",
  wordAddedBackground: "color-mix(in oklch, var(--success) 35%, transparent)",
  wordRemovedBackground:
    "color-mix(in oklch, var(--destructive) 35%, transparent)",
  addedGutterBackground: "color-mix(in oklch, var(--success) 22%, transparent)",
  removedGutterBackground:
    "color-mix(in oklch, var(--destructive) 22%, transparent)",
  gutterBackground: "var(--muted)",
  gutterBackgroundDark: "var(--muted)",
  highlightBackground: "color-mix(in oklch, var(--foreground) 8%, transparent)",
  highlightGutterBackground:
    "color-mix(in oklch, var(--foreground) 8%, transparent)",
  codeFoldGutterBackground: "var(--muted)",
  codeFoldBackground: "var(--muted)",
  emptyLineBackground: "var(--muted)",
  codeFoldContentColor: "var(--muted-foreground)",
};

const branchMockDiffViewerStyles = {
  variables: {
    light: branchMockDiffVars,
    dark: branchMockDiffVars,
  },
  line: {
    padding: "4px 8px",
    fontSize: "12px",
    fontFamily: "var(--font-mono), monospace",
  },
  gutter: {
    padding: "4px 8px",
    fontSize: "11px",
    minWidth: "40px",
  },
  contentText: {
    fontSize: "12px",
    fontFamily: "var(--font-mono), monospace",
  },
};

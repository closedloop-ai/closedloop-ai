"use client";

import type { BranchViewFileDiff } from "@repo/api/src/types/branch-view";
import { ScrollArea } from "@repo/design-system/components/ui/scroll-area";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { useTheme } from "next-themes";
import { type ReactNode, useEffect, useState } from "react";
import ReactDiffViewer, {
  DiffMethod,
  type ReactDiffViewerProps,
} from "react-diff-viewer-continued";
import { branchDiffViewerStyles } from "./branch-diff-viewer-theme";

export type BranchFileDiffViewerProps = {
  diffData: BranchViewFileDiff | undefined;
  diffError: unknown;
  isDiffLoading: boolean;
  className?: string;
  binaryFallback?: ReactNode;
  errorFallback?: ReactNode;
  leadingContent?: ReactNode;
  loadingFallback?: ReactNode;
  scrollAreaClassName?: string;
  viewerProps?: Partial<ReactDiffViewerProps>;
};

/**
 * Shared branch file-diff renderer used by the web branch review surface and
 * the desktop branch detail file list. It owns the common loading, error,
 * binary, and text-diff states so both surfaces render the same diff semantics.
 */
export function BranchFileDiffViewer({
  binaryFallback,
  className,
  diffData,
  diffError,
  errorFallback,
  isDiffLoading,
  leadingContent,
  loadingFallback,
  scrollAreaClassName,
  viewerProps,
}: BranchFileDiffViewerProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const responsiveSplitView = useResponsiveDiffSplitView();

  if (isDiffLoading) {
    if (loadingFallback) {
      return loadingFallback;
    }
    return (
      <div className={className ?? "grid gap-2 p-3 sm:grid-cols-2"}>
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    );
  }

  if (diffError) {
    if (errorFallback) {
      return errorFallback;
    }
    return (
      <p className="p-3 text-muted-foreground text-xs">
        Failed to load this file diff.
      </p>
    );
  }

  if (diffData?.isBinary) {
    if (binaryFallback) {
      return binaryFallback;
    }
    return (
      <p className="p-3 text-muted-foreground text-xs">
        Binary file diff not shown.
      </p>
    );
  }

  const {
    newValue: _newValue,
    oldValue: _oldValue,
    splitView: _splitView,
    useDarkTheme: _useDarkTheme,
    ...restViewerProps
  } = viewerProps ?? {};
  const splitView = viewerProps?.splitView ?? responsiveSplitView;

  return (
    <ScrollArea className={scrollAreaClassName ?? className ?? "max-h-[32rem]"}>
      {leadingContent}
      <ReactDiffViewer
        compareMethod={DiffMethod.WORDS}
        hideLineNumbers={false}
        newValue={diffData?.newContent ?? ""}
        oldValue={diffData?.oldContent ?? ""}
        {...restViewerProps}
        splitView={splitView}
        styles={viewerProps?.styles ?? branchDiffViewerStyles}
        useDarkTheme={isDark}
      />
    </ScrollArea>
  );
}

/**
 * Keeps desktop/tablet diffs side-by-side while switching narrow branch-detail
 * previews to a unified diff so code content remains readable without clipped
 * half-width columns.
 */
function useResponsiveDiffSplitView() {
  const [splitView, setSplitView] = useState(true);

  useEffect(() => {
    if (globalThis.window === undefined || !globalThis.window.matchMedia) {
      return;
    }
    const mediaQuery = globalThis.window.matchMedia(NARROW_DIFF_MEDIA_QUERY);
    const updateSplitView = () => setSplitView(!mediaQuery.matches);

    updateSplitView();
    mediaQuery.addEventListener("change", updateSplitView);
    return () => mediaQuery.removeEventListener("change", updateSplitView);
  }, []);

  return splitView;
}

const NARROW_DIFF_MEDIA_QUERY = "(max-width: 640px)";

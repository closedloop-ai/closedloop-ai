"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  FileCode,
  FileEdit,
  FilePlus,
  FileX,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
} from "lucide-react";
import { type ComponentType, useState } from "react";
import ReactDiffViewerBase, {
  DiffMethod,
  type ReactDiffViewerProps,
} from "react-diff-viewer-continued";
import { CommitDialog } from "@/components/engineer/CommitDialog";
import { useThemeContext } from "@/components/engineer/ThemeProvider";
import { diffViewerStyles } from "@/lib/diff-viewer-theme";
import { getWorktreePath } from "@/lib/engineer/chat-utils";
import {
  type FileDiff,
  gitBranchDiffOptions,
  gitDiffOptions,
  gitStatusOptions,
} from "@/lib/engineer/queries/git";
import { reposOptions } from "@/lib/engineer/queries/repos";

// react-diff-viewer-continued@4.1.2 ships a class component whose types are
// incompatible with @types/react@19 JSX inference. Casting to ComponentType
// lets TypeScript treat it as a standard React component in JSX.
const ReactDiffViewer =
  ReactDiffViewerBase as unknown as ComponentType<ReactDiffViewerProps>;

type DiffMode = "working" | "branch";

type ChangedFilesViewerProps = {
  ticketId: string;
  repoPath: string;
  hideCommitButton?: boolean;
  onSelectedFileChange?: (file: string | null) => void;
};

export function ChangedFilesViewer({
  ticketId,
  repoPath,
  hideCommitButton,
  onSelectedFileChange,
}: Readonly<ChangedFilesViewerProps>) {
  const { theme } = useThemeContext();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>("working");
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [prevTicketId, setPrevTicketId] = useState(ticketId);
  const { data: reposData } = useQuery(reposOptions());
  const worktreePath = getWorktreePath(
    repoPath,
    ticketId,
    reposData?.settings?.worktreeParentDir
  );
  // Reset selected file when ticketId changes (render-time state adjustment)
  if (prevTicketId !== ticketId) {
    setPrevTicketId(ticketId);
    setSelectedFile(null);
    onSelectedFileChange?.(null);
  }

  // Helper to update selected file and notify parent
  const handleSelectFile = (file: string | null) => {
    setSelectedFile(file);
    onSelectedFileChange?.(file);
  };

  // Fetch working directory changes (git status) — always enabled so we know if there are uncommitted changes
  const { data: workingFiles, isLoading: workingLoading } = useQuery({
    ...gitStatusOptions(worktreePath),
    refetchInterval: 5000,
  });

  // Fetch branch diff (changes vs parent branch)
  const { data: branchDiff, isLoading: branchLoading } = useQuery({
    ...gitBranchDiffOptions(worktreePath),
    refetchInterval: 10_000,
    enabled: diffMode === "branch",
  });

  // Normalize file data based on mode
  const files = diffMode === "working" ? workingFiles : branchDiff?.files;
  const filesLoading = diffMode === "working" ? workingLoading : branchLoading;

  // Fetch diff for selected file
  const { data: diff, isLoading: diffLoading } = useQuery(
    gitDiffOptions(worktreePath, selectedFile, diffMode, branchDiff?.baseBranch)
  );

  const totalFiles = files
    ? files.modified.length + files.created.length + files.deleted.length
    : 0;

  const hasWorkingChanges = workingFiles
    ? workingFiles.modified.length +
        workingFiles.created.length +
        workingFiles.deleted.length >
      0
    : false;

  if (filesLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-5 animate-spin" />
        Loading files...
      </div>
    );
  }

  // Show diff view
  if (selectedFile) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b p-3">
          <Button
            className="gap-1"
            onClick={() => handleSelectFile(null)}
            size="sm"
            variant="ghost"
          >
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <span className="truncate font-mono text-muted-foreground text-sm">
            {selectedFile}
          </span>
        </div>
        <DiffContent diff={diff} diffLoading={diffLoading} theme={theme} />
      </div>
    );
  }

  // Show file list
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b p-3">
        {/* Mode toggle */}
        <div className="flex gap-1 rounded-lg bg-muted p-0.5">
          <button
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-medium text-xs transition-colors",
              diffMode === "working"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setDiffMode("working")}
          >
            <FileCode className="size-3.5" />
            Working
          </button>
          <button
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-medium text-xs transition-colors",
              diffMode === "branch"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setDiffMode("branch")}
          >
            <GitBranch className="size-3.5" />
            Branch
          </button>
        </div>
        {/* File count and branch info */}
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-sm">
            {totalFiles} changed file{totalFiles === 1 ? "" : "s"}
          </h3>
          {diffMode === "branch" && branchDiff && (
            <span className="font-mono text-[10px] text-muted-foreground">
              vs {branchDiff.baseBranch}
            </span>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-auto p-3">
        {totalFiles === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            No changed files
          </div>
        ) : (
          <>
            {files?.modified.map((file) => (
              <FileListItem
                file={file}
                key={file}
                onClick={() => handleSelectFile(file)}
                type="modified"
              />
            ))}
            {files?.created.map((file) => (
              <FileListItem
                file={file}
                key={file}
                onClick={() => handleSelectFile(file)}
                type="created"
              />
            ))}
            {files?.deleted.map((file) => (
              <FileListItem
                file={file}
                key={file}
                onClick={() => handleSelectFile(file)}
                type="deleted"
              />
            ))}
          </>
        )}
      </div>
      {hasWorkingChanges && !hideCommitButton && (
        <div className="shrink-0 border-t p-3">
          <Button
            className="w-full gap-2"
            onClick={() => setCommitDialogOpen(true)}
            size="sm"
          >
            <GitCommitHorizontal className="size-4" />
            Commit & Push
          </Button>
        </div>
      )}
      <CommitDialog
        onOpenChange={setCommitDialogOpen}
        onSuccess={() => setCommitDialogOpen(false)}
        open={commitDialogOpen}
        repoPath={repoPath}
        ticketId={ticketId}
      />
    </div>
  );
}

function ImageDiffViewer({ diff }: Readonly<{ diff: FileDiff }>) {
  const src = (content: string) => `data:${diff.mimeType};base64,${content}`;

  if (diff.isNew) {
    return (
      <div className="space-y-2 p-4">
        <span className="font-medium text-emerald-500 text-xs">New file</span>
        <div className="inline-block rounded border border-border bg-muted/30 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- data URI; next/image cannot optimize base64 */}
          <img alt="New" className="max-w-full" src={src(diff.newContent)} />
        </div>
      </div>
    );
  }

  if (diff.isDeleted) {
    return (
      <div className="space-y-2 p-4">
        <span className="font-medium text-red-500 text-xs">Deleted</span>
        <div className="inline-block rounded border border-border bg-muted/30 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- data URI; next/image cannot optimize base64 */}
          <img
            alt="Deleted"
            className="max-w-full opacity-60"
            src={src(diff.oldContent)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 p-4">
      <div className="space-y-2">
        <span className="font-medium text-muted-foreground text-xs">
          Before
        </span>
        <div className="rounded border border-border bg-muted/30 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- data URI; next/image cannot optimize base64 */}
          <img alt="Before" className="max-w-full" src={src(diff.oldContent)} />
        </div>
      </div>
      <div className="space-y-2">
        <span className="font-medium text-muted-foreground text-xs">After</span>
        <div className="rounded border border-border bg-muted/30 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- data URI; next/image cannot optimize base64 */}
          <img alt="After" className="max-w-full" src={src(diff.newContent)} />
        </div>
      </div>
    </div>
  );
}

type FileListItemProps = {
  file: string;
  type: "modified" | "created" | "deleted";
  onClick: () => void;
};

const fileTypeIcons = {
  modified: FileEdit,
  created: FilePlus,
  deleted: FileX,
} as const;
const fileTypeColors = {
  modified: "text-amber-500",
  created: "text-emerald-500",
  deleted: "text-red-500",
} as const;

function FileListItem({ file, type, onClick }: Readonly<FileListItemProps>) {
  const Icon = fileTypeIcons[type];
  const iconColor = fileTypeColors[type];

  return (
    <div
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left",
        "cursor-pointer transition-colors hover:bg-muted/50",
        "text-muted-foreground text-sm hover:text-foreground"
      )}
      onClick={() => {
        const selection = globalThis.getSelection();
        if (selection && selection.toString().length > 0) {
          return;
        }
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          onClick();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <Icon className={cn("size-4 shrink-0", iconColor)} />
      <span className="truncate font-mono text-xs" title={file}>
        {file}
      </span>
    </div>
  );
}

function DiffContent({
  diff,
  diffLoading,
  theme,
}: Readonly<{
  diff: FileDiff | undefined;
  diffLoading: boolean;
  theme: string;
}>) {
  if (diffLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-5 animate-spin" />
        Loading diff...
      </div>
    );
  }

  if (!diff) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Failed to load diff
      </div>
    );
  }

  if (diff.isImage) {
    return (
      <div className="diff-viewer-scrollbar min-h-0 flex-1 overflow-auto">
        <ImageDiffViewer diff={diff} />
      </div>
    );
  }

  return (
    <div className="diff-viewer-scrollbar min-h-0 flex-1 overflow-auto">
      <ReactDiffViewer
        compareMethod={DiffMethod.WORDS}
        hideLineNumbers={false}
        newValue={diff.newContent}
        oldValue={diff.oldContent}
        splitView={false}
        styles={diffViewerStyles}
        useDarkTheme={theme === "dark"}
      />
    </div>
  );
}

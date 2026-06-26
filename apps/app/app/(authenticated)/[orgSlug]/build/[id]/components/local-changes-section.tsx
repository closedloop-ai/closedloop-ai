"use client";

import { FileChangeStatus } from "@repo/api/src/types/branch-view";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import {
  CircleDot,
  CirclePlus,
  FileX,
  GitCommitHorizontal,
  Loader2,
} from "lucide-react";
import type { BranchViewFile, FileSection } from "../types";
import { ChangesSection } from "./changes-section";

type LocalChangesSectionProps = {
  commitError?: unknown;
  commitUnavailableReason: string | null;
  files: BranchViewFile[];
  isCommitPending: boolean;
  localError?: unknown;
  onCommitAndPush?: () => void;
  section: FileSection;
  onSelectFile: (path: string) => void;
  selectedFileId: string | null;
};

function StatusIcon({ status }: { status: BranchViewFile["status"] }) {
  const className = "h-4 w-4 shrink-0";
  if (status === FileChangeStatus.Added) {
    return <CirclePlus className={cn(className, "text-success")} />;
  }
  if (status === FileChangeStatus.Removed) {
    return <FileX className={cn(className, "text-destructive")} />;
  }
  return <CircleDot className={cn(className, "text-warning")} />;
}

function localErrorMessage(commitError: unknown, localError: unknown): string {
  if (commitError instanceof Error) {
    return commitError.message;
  }
  if (localError instanceof Error) {
    return localError.message;
  }
  return "Local changes unavailable";
}

export function LocalChangesSection({
  commitError,
  commitUnavailableReason,
  files,
  isCommitPending,
  localError,
  onCommitAndPush,
  section,
  onSelectFile,
  selectedFileId,
}: Readonly<LocalChangesSectionProps>) {
  return (
    <ChangesSection
      actionButton={
        <div className="flex min-w-0 flex-col items-end gap-1">
          <Button
            className="h-8 max-w-full px-3"
            disabled={
              isCommitPending ||
              Boolean(commitUnavailableReason) ||
              !onCommitAndPush
            }
            onClick={onCommitAndPush}
            size="sm"
            type="button"
          >
            {isCommitPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <GitCommitHorizontal className="mr-1.5 h-4 w-4" />
            )}
            <span className="truncate">Commit & push</span>
          </Button>
          {commitError || localError ? (
            <span className="max-w-80 truncate text-destructive text-xs">
              {localErrorMessage(commitError, localError)}
            </span>
          ) : null}
        </div>
      }
      files={files}
      onSelectFile={onSelectFile}
      renderFileIcon={(file) => <StatusIcon status={file.status} />}
      section={section}
      selectedFileId={selectedFileId}
      title="Local Changes"
    />
  );
}

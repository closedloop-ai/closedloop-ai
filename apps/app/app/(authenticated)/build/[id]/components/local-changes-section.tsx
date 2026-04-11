"use client";

import { FileChangeStatus } from "@repo/api/src/types/branch-view";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import {
  CircleDot,
  CirclePlus,
  FileX,
  GitCommitHorizontal,
} from "lucide-react";
import type { BranchViewFile, FileSection } from "../types";
import { ChangesSection } from "./changes-section";

type LocalChangesSectionProps = {
  files: BranchViewFile[];
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

export function LocalChangesSection({
  files,
  section,
  onSelectFile,
  selectedFileId,
}: Readonly<LocalChangesSectionProps>) {
  return (
    <ChangesSection
      actionButton={
        <Button className="h-8 px-3" size="sm">
          <GitCommitHorizontal className="mr-1.5 h-4 w-4" />
          Commit & push
        </Button>
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

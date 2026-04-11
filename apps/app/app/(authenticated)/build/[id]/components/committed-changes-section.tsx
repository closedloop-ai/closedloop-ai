"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { GitPullRequestArrow } from "lucide-react";
import type { BranchViewFile, FileSection } from "../types";
import { ChangesSection } from "./changes-section";

type CommittedChangesSectionProps = {
  files: BranchViewFile[];
  section: FileSection;
  onSelectFile: (path: string) => void;
  selectedFileId: string | null;
  /** When true, "Create PR" is disabled (PR already exists). */
  hasPr?: boolean;
};

export function CommittedChangesSection({
  files,
  section,
  onSelectFile,
  selectedFileId,
  hasPr = true,
}: Readonly<CommittedChangesSectionProps>) {
  return (
    <ChangesSection
      actionButton={
        <Button
          className="h-8 shrink-0 px-3 opacity-40"
          disabled={hasPr}
          size="sm"
          type="button"
          variant="secondary"
        >
          <GitPullRequestArrow className="mr-1.5 h-4 w-4" />
          Create PR
        </Button>
      }
      files={files}
      onSelectFile={onSelectFile}
      section={section}
      selectedFileId={selectedFileId}
      title="Committed Changes"
    />
  );
}

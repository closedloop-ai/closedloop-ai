"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  DownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SettingsIcon,
  SparklesIcon,
  TrashIcon,
} from "lucide-react";
import { EditorHeader } from "@/components/artifact-editor/editor-header";

type IssueEditorHeaderProps = {
  issue: ArtifactWithWorkstream;
  status: string;
  isSaving: boolean;
  lastSaved: Date;
  showMetadataPanel: boolean;
  onToggleMetadataPanel: () => void;
  onGeneratePlan: () => void;
  onSave: () => void;
  onRename: () => void;
  onExport: () => void;
  onDelete: () => void;
  versionDisplay?: React.ReactNode;
  isPending?: boolean;
};

export function IssueEditorHeader({
  issue,
  status,
  isSaving,
  lastSaved,
  showMetadataPanel,
  onToggleMetadataPanel,
  onGeneratePlan,
  onSave,
  onRename,
  onExport,
  onDelete,
  versionDisplay,
  isPending = false,
}: IssueEditorHeaderProps) {
  const hasProject = Boolean(issue.project?.teams?.[0]?.id);
  const backHref = hasProject
    ? `/teams/${issue.project?.teams?.[0]?.id}/projects/${issue.project?.id}`
    : "/";
  const backLabel = hasProject ? "Back to Project" : "Back to Home";

  const rightActions = (
    <>
      <Button
        onClick={onToggleMetadataPanel}
        size="sm"
        variant={showMetadataPanel ? "secondary" : "outline"}
      >
        <SettingsIcon className="mr-2 h-4 w-4" />
        Details
      </Button>

      <Button onClick={onGeneratePlan} size="sm" variant="default">
        <SparklesIcon className="mr-2 h-4 w-4" />
        Generate Plan
      </Button>

      <Button disabled={isPending} onClick={onSave}>
        {isSaving ? "Saving..." : "Save"}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost">
            <MoreHorizontalIcon className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[160px]">
          <DropdownMenuItem onClick={onRename}>
            <PencilIcon className="mr-2 h-4 w-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onExport}>
            <DownloadIcon className="mr-2 h-4 w-4" />
            Export .md
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={onDelete}
          >
            <TrashIcon className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <EditorHeader
      backHref={backHref}
      backLabel={backLabel}
      isSaving={isSaving}
      lastSaved={lastSaved}
      rightActions={rightActions}
      status={status}
      title={issue.fileName ?? issue.title}
      versionDisplay={versionDisplay}
    />
  );
}

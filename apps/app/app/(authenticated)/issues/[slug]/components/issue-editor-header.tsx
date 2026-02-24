"use client";

import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  MoreHorizontalIcon,
  PencilIcon,
  SettingsIcon,
  TrashIcon,
} from "lucide-react";
import { EditorHeader } from "@/components/artifact-editor/editor-header";

type IssueEditorHeaderProps = {
  issue: IssueWithWorkstream;
  isSaving: boolean;
  lastSaved: Date;
  showMetadataPanel: boolean;
  onToggleMetadataPanel: () => void;
  onSave: () => void;
  onRename: () => void;
  onDelete: () => void;
  isPending?: boolean;
};

export function IssueEditorHeader({
  issue,
  isSaving,
  lastSaved,
  showMetadataPanel,
  onToggleMetadataPanel,
  onSave,
  onRename,
  onDelete,
  isPending = false,
}: Readonly<IssueEditorHeaderProps>) {
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
      status={issue.status}
      title={issue.title}
    />
  );
}

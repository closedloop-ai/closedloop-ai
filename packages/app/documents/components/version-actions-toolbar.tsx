"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Toggle } from "@repo/design-system/components/ui/toggle";
import { MessageSquareDotIcon } from "lucide-react";

type VersionActionsToolbarProps = {
  canRestoreVersion?: boolean;
  onRestoreVersion: () => void;
  isRestoring?: boolean;
  canSaveVersion?: boolean;
  hasUnsavedChanges?: boolean;
  onSaveVersion: () => void;
  isSaving?: boolean;
  onToggleComments: (pressed: boolean) => void;
  openThreadCount: number;
  showComments: boolean;
  showCommentToggle?: boolean;
};

export function VersionActionsToolbar({
  canRestoreVersion = false,
  onRestoreVersion,
  isRestoring = false,
  canSaveVersion = true,
  hasUnsavedChanges = true,
  onSaveVersion,
  isSaving = false,
  onToggleComments,
  openThreadCount,
  showComments,
  showCommentToggle = true,
}: Readonly<VersionActionsToolbarProps>) {
  return (
    <>
      {showCommentToggle && openThreadCount > 0 ? (
        <Toggle
          className="px-3"
          onPressedChange={onToggleComments}
          pressed={showComments}
          size="sm"
          variant="outline"
        >
          <MessageSquareDotIcon className="h-4 w-4" />
          {openThreadCount}
        </Toggle>
      ) : null}
      <Button
        disabled={!canRestoreVersion || isRestoring}
        onClick={onRestoreVersion}
        size="sm"
        variant="outline"
      >
        Restore Version
      </Button>
      {canSaveVersion ? (
        <Button
          disabled={isSaving || !hasUnsavedChanges}
          onClick={onSaveVersion}
          size="sm"
          variant="default"
        >
          {isSaving ? "Publishing..." : "Publish"}
        </Button>
      ) : null}
    </>
  );
}

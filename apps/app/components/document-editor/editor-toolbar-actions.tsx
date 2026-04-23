"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Toggle } from "@repo/design-system/components/ui/toggle";
import { MessageSquareDotIcon } from "lucide-react";

type EditorToolbarActionsProps = {
  canRestoreVersion?: boolean;
  onRestoreVersion: () => void;
  isRestoring?: boolean;
  canSaveVersion?: boolean;
  onSaveVersion: () => void;
  isSaving?: boolean;
  onToggleComments: (pressed: boolean) => void;
  openThreadCount: number;
  showComments: boolean;
};

export function EditorToolbarActions({
  canRestoreVersion = false,
  onRestoreVersion,
  isRestoring = false,
  canSaveVersion = true,
  onSaveVersion,
  isSaving = false,
  onToggleComments,
  openThreadCount,
  showComments,
}: Readonly<EditorToolbarActionsProps>) {
  return (
    <>
      {openThreadCount > 0 && (
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
      )}
      <Button
        disabled={!canRestoreVersion || isRestoring}
        onClick={onRestoreVersion}
        size="sm"
        variant="outline"
      >
        Restore Version
      </Button>
      {canSaveVersion && (
        <Button
          disabled={isSaving}
          // swallow the event
          onClick={() => onSaveVersion()}
          size="sm"
          variant="outline"
        >
          {isSaving ? "Saving..." : "Save New Version"}
        </Button>
      )}
    </>
  );
}

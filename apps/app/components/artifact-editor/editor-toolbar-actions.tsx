"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Toggle } from "@repo/design-system/components/ui/toggle";
import { MessageSquareDotIcon } from "lucide-react";

type EditorToolbarActionsProps = {
  isPending: boolean;
  isSaving: boolean;
  onRestoreVersion: () => void;
  onSaveVersion: () => void;
  onToggleComments: (pressed: boolean) => void;
  openThreadCount: number;
  showComments: boolean;
  showRestoreVersion?: boolean;
};

export function EditorToolbarActions({
  isPending,
  isSaving,
  onRestoreVersion,
  onSaveVersion,
  onToggleComments,
  openThreadCount,
  showComments,
  showRestoreVersion = true,
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
      {showRestoreVersion && (
        <Button
          disabled={isPending}
          onClick={onRestoreVersion}
          size="sm"
          variant="outline"
        >
          Restore Version
        </Button>
      )}
      <Button
        disabled={isPending}
        onClick={onSaveVersion}
        size="sm"
        variant="outline"
      >
        {isSaving ? "Saving..." : "Save New Version"}
      </Button>
    </>
  );
}

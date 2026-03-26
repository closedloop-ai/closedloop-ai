"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Toggle } from "@repo/design-system/components/ui/toggle";
import { MessageSquareDotIcon } from "lucide-react";

type EditorToolbarActionsProps = {
  isEditing: boolean;
  isPending: boolean;
  isSaving: boolean;
  isViewingHistorical: boolean;
  onDiscard: () => void;
  onEdit: () => void;
  onPublish: () => void;
  onToggleComments: (pressed: boolean) => void;
  openThreadCount: number;
  showComments: boolean;
};

export function EditorToolbarActions({
  isEditing,
  isPending,
  isSaving,
  isViewingHistorical,
  onDiscard,
  onEdit,
  onPublish,
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
      {isEditing ? (
        <>
          <Button
            disabled={isPending}
            onClick={onDiscard}
            size="sm"
            variant="outline"
          >
            Discard
          </Button>
          <Button disabled={isPending} onClick={onPublish} size="sm">
            {isSaving ? "Publishing..." : "Publish"}
          </Button>
        </>
      ) : (
        <Button
          disabled={isViewingHistorical}
          onClick={onEdit}
          size="sm"
          variant="secondary"
        >
          Edit
        </Button>
      )}
    </>
  );
}

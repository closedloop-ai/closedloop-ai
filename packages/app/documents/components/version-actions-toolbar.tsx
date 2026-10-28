"use client";

import { Button } from "@repo/design-system/components/ui/button";

type VersionActionsToolbarProps = {
  canRestoreVersion?: boolean;
  onRestoreVersion: () => void;
  isRestoring?: boolean;
  canSaveVersion?: boolean;
  hasUnsavedChanges?: boolean;
  onSaveVersion: () => void;
  isSaving?: boolean;
};

export function VersionActionsToolbar({
  canRestoreVersion = false,
  onRestoreVersion,
  isRestoring = false,
  canSaveVersion = true,
  hasUnsavedChanges = true,
  onSaveVersion,
  isSaving = false,
}: Readonly<VersionActionsToolbarProps>) {
  return (
    <>
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

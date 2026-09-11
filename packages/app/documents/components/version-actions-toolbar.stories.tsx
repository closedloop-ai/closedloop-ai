import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { VersionActionsToolbar } from "./version-actions-toolbar";

function VersionActionsToolbarDemo({
  canRestoreVersion = true,
  canSaveVersion = true,
  hasUnsavedChanges = true,
  openThreadCount = 3,
  showCommentToggle = true,
  isRestoring = false,
  isSaving = false,
}: {
  canRestoreVersion?: boolean;
  canSaveVersion?: boolean;
  hasUnsavedChanges?: boolean;
  openThreadCount?: number;
  showCommentToggle?: boolean;
  isRestoring?: boolean;
  isSaving?: boolean;
}) {
  const [showComments, setShowComments] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <VersionActionsToolbar
        canRestoreVersion={canRestoreVersion}
        canSaveVersion={canSaveVersion}
        hasUnsavedChanges={hasUnsavedChanges}
        isRestoring={isRestoring}
        isSaving={isSaving}
        onRestoreVersion={() => undefined}
        onSaveVersion={() => undefined}
        onToggleComments={setShowComments}
        openThreadCount={openThreadCount}
        showComments={showComments}
        showCommentToggle={showCommentToggle}
      />
    </div>
  );
}

/**
 * A row of buttons for working with a document version: an optional comment
 * count toggle, a Restore Version button, and a Publish button that reads
 * Publishing while the save is running. The comment toggle only shows up
 * when there are open threads to reveal, and Restore stays disabled while a
 * restore is already in progress or the version simply can't be restored.
 * Publish stays disabled until there's actually something unsaved to
 * publish.
 */
const meta = {
  title: "Composites/Documents/Version Actions Toolbar",
  component: VersionActionsToolbarDemo,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof VersionActionsToolbarDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Saving: Story = {
  args: {
    isSaving: true,
  },
};

export const RestoreDisabled: Story = {
  args: {
    canRestoreVersion: false,
    openThreadCount: 0,
  },
};

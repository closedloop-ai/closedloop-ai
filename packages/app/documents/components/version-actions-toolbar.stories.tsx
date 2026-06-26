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

const meta = {
  title: "App Core/Documents/Version Actions Toolbar",
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

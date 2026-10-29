import type { Meta, StoryObj } from "@storybook/react";
import { VersionActionsToolbar } from "./version-actions-toolbar";

function VersionActionsToolbarDemo({
  canRestoreVersion = true,
  canSaveVersion = true,
  hasUnsavedChanges = true,
  isRestoring = false,
  isSaving = false,
}: {
  canRestoreVersion?: boolean;
  canSaveVersion?: boolean;
  hasUnsavedChanges?: boolean;
  isRestoring?: boolean;
  isSaving?: boolean;
}) {
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
      />
    </div>
  );
}

const meta = {
  title: "Composites v1.0/Documents/Version Actions Toolbar",
  component: VersionActionsToolbarDemo,
  tags: ["deprecated", "autodocs"],
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
  },
};

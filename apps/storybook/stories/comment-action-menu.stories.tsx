import { CommentActionMenu } from "@repo/design-system/components/ui/comment-action-menu";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

function CommentActionMenuStory() {
  const [lastAction, setLastAction] = useState("No action yet");

  return (
    <div className="flex max-w-md items-start justify-between rounded-lg border bg-card p-4">
      <div className="space-y-1">
        <div className="font-medium text-sm">PR review thread</div>
        <div className="text-muted-foreground text-xs">{lastAction}</div>
      </div>
      <CommentActionMenu
        copySuccessMessage="Copied PR link"
        copyValue="https://example.com/pr/42#discussion_r1"
        onChatAboutThis={() => setLastAction("Chat About This")}
        onDelete={() => setLastAction("Delete")}
        onEditToggle={() => setLastAction("Edit")}
        onResolveAction={() => setLastAction("Resolve Conversation")}
        resolveLabel="Resolve Conversation"
      />
    </div>
  );
}

const meta = {
  title: "Design System/Documents & Conversation/Comment Action Menu",
  component: CommentActionMenuStory,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof CommentActionMenuStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ReplyActions: Story = {
  render: () => (
    <div className="flex max-w-md items-start justify-between rounded-lg border bg-card p-4">
      <div className="space-y-1">
        <div className="font-medium text-sm">Reply</div>
        <div className="text-muted-foreground text-xs">
          Reduced menu with edit/delete only
        </div>
      </div>
      <CommentActionMenu
        canDelete
        canEdit
        onDelete={() => undefined}
        onEditToggle={() => undefined}
      />
    </div>
  ),
};

export const DisabledActions: Story = {
  render: () => (
    <div className="flex max-w-md items-start justify-between rounded-lg border bg-card p-4">
      <div className="space-y-1">
        <div className="font-medium text-sm">Locked thread</div>
        <div className="text-muted-foreground text-xs">
          Resolve is pending and edit/delete are unavailable
        </div>
      </div>
      <CommentActionMenu
        canDelete={false}
        canEdit={false}
        isResolvePending
        onDelete={() => undefined}
        onEditToggle={() => undefined}
        onResolveAction={() => undefined}
        resolveLabel="Resolve Conversation"
      />
    </div>
  ),
};

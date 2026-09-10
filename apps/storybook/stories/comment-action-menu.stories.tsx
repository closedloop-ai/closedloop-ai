import { CommentActionMenu } from "@repo/design-system/components/ui/comment-action-menu";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

type CommentActionMenuStoryProps = {
  canDelete?: boolean;
  canEdit?: boolean;
  chatLabel?: string;
  copySuccessMessage?: string;
  copyValue?: string | null;
  isResolvePending?: boolean;
  resolveLabel?: string;
};

function CommentActionMenuStory({
  canDelete = true,
  canEdit = true,
  chatLabel = "Chat About This",
  copySuccessMessage = "Copied PR link",
  copyValue = "https://example.com/pr/42#discussion_r1",
  isResolvePending = false,
  resolveLabel = "Resolve Conversation",
}: CommentActionMenuStoryProps) {
  const [lastAction, setLastAction] = useState("No action yet");

  return (
    <div className="flex max-w-md items-start justify-between rounded-lg border bg-card p-4">
      <div className="space-y-1">
        <div className="font-medium text-sm">PR review thread</div>
        <div className="text-muted-foreground text-xs">{lastAction}</div>
      </div>
      <CommentActionMenu
        canDelete={canDelete}
        canEdit={canEdit}
        chatLabel={chatLabel}
        copySuccessMessage={copySuccessMessage}
        copyValue={copyValue}
        isResolvePending={isResolvePending}
        onChatAboutThis={() => setLastAction(chatLabel)}
        onDelete={() => setLastAction("Delete")}
        onEditToggle={() => setLastAction("Edit")}
        onResolveAction={() => setLastAction(resolveLabel)}
        resolveLabel={resolveLabel}
      />
    </div>
  );
}

const meta = {
  title: "Composites/Overlays/Comment Action Menu",
  component: CommentActionMenuStory,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    canEdit: { control: "boolean" },
    canDelete: { control: "boolean" },
    isResolvePending: {
      control: "boolean",
      description: "Disables the resolve item while a resolve is in flight.",
    },
    resolveLabel: {
      control: "text",
      description: "Empty hides the resolve item entirely.",
    },
    chatLabel: { control: "text" },
    copyValue: {
      control: "text",
      description: "Link the Copy Link item writes. Empty hides that item.",
    },
    copySuccessMessage: { control: "text" },
  },
  args: {
    canDelete: true,
    canEdit: true,
    chatLabel: "Chat About This",
    copySuccessMessage: "Copied PR link",
    copyValue: "https://example.com/pr/42#discussion_r1",
    isResolvePending: false,
    resolveLabel: "Resolve Conversation",
  },
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

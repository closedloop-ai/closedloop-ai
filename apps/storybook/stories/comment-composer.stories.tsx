import { Button } from "@repo/design-system/components/ui/button";
import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";
import type { Meta, StoryObj } from "@storybook/react";
import { AtSign, GithubIcon, Paperclip } from "lucide-react";
import { type ComponentProps, useState } from "react";

function CommentComposerStory(args: ComponentProps<typeof CommentComposer>) {
  const [value, setValue] = useState(args.value ?? "");

  return (
    <div className="max-w-xl rounded-lg border bg-background">
      <CommentComposer
        {...args}
        onCancel={() => setValue(args.defaultValue ?? "")}
        onSubmit={() => setValue("")}
        onValueChange={setValue}
        value={value}
      />
    </div>
  );
}

const meta = {
  title: "Design System/Documents & Conversation/Comment Composer",
  component: CommentComposerStory,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    onSubmit: () => undefined,
  },
} satisfies Meta<typeof CommentComposerStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation: Story = {
  args: {
    containerClassName: "border-border border-t bg-background p-3",
    helperText: (
      <div className="mb-1 flex items-center gap-1.5 text-muted-foreground text-xs">
        <GithubIcon className="h-3 w-3" />
        <span>Comments here sync to GitHub · PR #142</span>
      </div>
    ),
    leadingActions: (
      <>
        <Button
          aria-disabled
          aria-label="Attach file (coming soon)"
          className="h-7 w-7"
          size="icon"
          tabIndex={-1}
          type="button"
          variant="ghost"
        >
          <Paperclip className="h-3.5 w-3.5" />
        </Button>
        <Button
          aria-disabled
          aria-label="Mention (coming soon)"
          className="h-7 w-7"
          size="icon"
          tabIndex={-1}
          type="button"
          variant="ghost"
        >
          <AtSign className="h-3.5 w-3.5" />
        </Button>
      </>
    ),
    minHeightClassName: "min-h-[64px]",
    placeholder: "Comment on this PR…",
    submitLabel: "Comment",
    value: "This is ready for merge once the rollout copy is tightened.",
  },
};

export const Reply: Story = {
  args: {
    containerClassName: "border-border border-t bg-muted/20 px-3 py-3",
    minHeightClassName: "min-h-[64px] max-h-[180px]",
    placeholder: "Reply…",
    submitLabel: "Reply",
  },
};

export const InlineEdit: Story = {
  args: {
    ariaLabel: "Edit comment",
    defaultValue:
      "The error handling still needs a user-facing fallback for timeout cases.",
    onCancel: () => undefined,
    submitLabel: "Save",
  },
};

import { Button } from "@repo/design-system/components/ui/button";
import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";
import type { Meta, StoryObj } from "@storybook/react";
import { AtSign, GithubIcon, Paperclip } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";

const COMMENT_ON_PR_LABEL = /comment on this pr/i;

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

/**
 * A text box for writing, replying to, or editing a comment, with Cancel and
 * submit buttons, that never loses your draft if a submission fails.
 */
const meta = {
  title: "Composites/Inputs/Comment Composer",
  component: CommentComposerStory,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    value: {
      control: "text",
      description:
        "Controlled draft body. This story seeds its local state from it.",
      table: { category: "Content" },
    },
    defaultValue: {
      control: "text",
      description: "Uncontrolled starting draft body.",
      table: { category: "Content" },
    },
    placeholder: { control: "text", table: { category: "Content" } },
    ariaLabel: {
      control: "text",
      description:
        "Accessible name for the textarea. Falls back to placeholder.",
      table: { category: "Content" },
    },
    submitLabel: { control: "text", table: { category: "Content" } },
    cancelLabel: { control: "text", table: { category: "Content" } },
    helperText: { control: false, table: { category: "Content" } },
    leadingActions: {
      control: false,
      description: "Nodes rendered at the left edge of the footer row.",
      table: { category: "Content" },
    },
    disabled: { control: "boolean", table: { category: "State" } },
    isPending: { control: "boolean", table: { category: "State" } },
    clearOnSubmit: {
      control: "boolean",
      description: "Uncontrolled mode only. Resets the draft on submit.",
      table: { category: "State" },
    },
    minHeightClassName: { control: "text", table: { category: "Appearance" } },
    containerClassName: { control: "text", table: { category: "Appearance" } },
    footerClassName: { control: "text", table: { category: "Appearance" } },
    onValueChange: { control: false, table: { category: "Events" } },
    onSubmit: { control: false, table: { category: "Events" } },
    onCancel: { control: false, table: { category: "Events" } },
  },
  args: {
    cancelLabel: "Cancel",
    clearOnSubmit: true,
    defaultValue: "",
    disabled: false,
    isPending: false,
    minHeightClassName: "min-h-[96px]",
    onCancel: fn(),
    onSubmit: fn(),
    onValueChange: fn(),
    placeholder: "Add a comment...",
    submitLabel: "Comment",
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // This story's own wrapper owns `onSubmit` (it clears the draft on submit),
    // so the visible outcome to assert is the draft clearing, not a spy call.
    const textbox = await canvas.findByRole("textbox", {
      name: COMMENT_ON_PR_LABEL,
    });
    await expect(textbox).toHaveValue(
      "This is ready for merge once the rollout copy is tightened."
    );
    await userEvent.click(canvas.getByRole("button", { name: "Comment" }));
    await expect(textbox).toHaveValue("");
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
    onCancel: fn(),
    submitLabel: "Save",
  },
};

import { Button } from "@repo/design-system/components/ui/button";
import { InlineEditEditorShell } from "@repo/design-system/components/ui/inline-edit-editor-shell";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

function InlineEditEditorShellDemo({
  initialExpanded = false,
}: {
  initialExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);

  return (
    <div className="max-w-3xl">
      <InlineEditEditorShell
        expanded={expanded}
        toolbar={
          <div className="flex items-center justify-between border-b px-4 py-2">
            <span className="text-muted-foreground text-sm">
              Editor toolbar
            </span>
            <Button size="sm" variant="outline">
              Publish
            </Button>
          </div>
        }
      >
        <button
          className="min-h-[180px] w-full px-4 py-6 text-left text-sm"
          onClick={() => setExpanded(true)}
          type="button"
        >
          {expanded
            ? "Expanded editor body with full editing chrome."
            : "Collapsed preview shell. Click to expand into edit mode."}
        </button>
      </InlineEditEditorShell>
    </div>
  );
}

const meta = {
  title: "Design System/Documents & Conversation/Inline Edit Editor Shell",
  component: InlineEditEditorShellDemo,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof InlineEditEditorShellDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Preview: Story = {};

export const Expanded: Story = {
  args: {
    initialExpanded: true,
  },
};

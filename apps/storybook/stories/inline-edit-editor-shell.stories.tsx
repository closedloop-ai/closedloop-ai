import { Button } from "@repo/design-system/components/ui/button";
import { InlineEditEditorShell } from "@repo/design-system/components/ui/inline-edit-editor-shell";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

function InlineEditEditorShellDemo({
  initialExpanded = false,
  paragraphCount = 1,
}: {
  initialExpanded?: boolean;
  paragraphCount?: number;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const trailingParagraphs = Array.from(
    { length: Math.max(0, paragraphCount - 1) },
    (_, index) =>
      `Body paragraph ${index + 2}. The shell never clips or scrolls its content — it grows to fit, so the page that hosts it stays the only scroll region.`
  );

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
          className="min-h-[180px] w-full space-y-4 px-4 py-6 text-left text-sm"
          onClick={() => setExpanded(true)}
          type="button"
        >
          <span className="block">
            {expanded
              ? "Expanded editor body with full editing chrome."
              : "Read-mode body. Click anywhere to expand into edit mode."}
          </span>
          {trailingParagraphs.map((paragraph) => (
            <span className="block" key={paragraph}>
              {paragraph}
            </span>
          ))}
        </button>
      </InlineEditEditorShell>
    </div>
  );
}

const meta = {
  title: "Primitives/Layout/Inline Edit Editor Shell",
  component: InlineEditEditorShellDemo,
  tags: ["autodocs"],
  argTypes: {
    initialExpanded: {
      control: "boolean",
      description:
        "Expanded state the demo seeds its own state with on first render.",
    },
    paragraphCount: {
      control: { type: "number", min: 1, max: 50, step: 1 },
      description: "Body paragraphs rendered inside the shell.",
    },
  },
  parameters: {
    layout: "padded",
  },
  args: {
    initialExpanded: false,
    paragraphCount: 1,
  },
} satisfies Meta<typeof InlineEditEditorShellDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ReadMode: Story = {};

export const Expanded: Story = {
  args: {
    initialExpanded: true,
  },
};

/**
 * The shell has no height ceiling: a long body renders in full and the hosting
 * page scrolls. Guards against reintroducing a clamped, internally-scrolling
 * read state, which would put a second scrollbar inside the page's own.
 */
export const LongContent: Story = {
  args: {
    paragraphCount: 30,
  },
};

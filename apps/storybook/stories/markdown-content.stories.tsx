import { MarkdownContent } from "@repo/design-system/components/ui/primitives/markdown-content";
import type { Meta, StoryObj } from "@storybook/react";

const text = [
  "## Monitoring summary",
  "",
  "- Unified sessions and activity surfaces",
  "- Reused shared breadcrumb, sidebar, and select primitives",
  "",
  "### Example",
  "",
  "export function Example() {",
  "  return <div>shared ui</div>;",
  "}",
].join("\n");

const meta = {
  title: "Design System/Primitives/Markdown Content",
  component: MarkdownContent,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { text },
} satisfies Meta<typeof MarkdownContent>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};

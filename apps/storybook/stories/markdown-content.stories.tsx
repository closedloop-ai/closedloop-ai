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
  argTypes: {
    text: { control: "text" },
    dense: {
      control: "boolean",
      description: "Tightens paragraph spacing and drops the body to 12px.",
    },
    skipHtml: {
      control: "boolean",
      description: "Drops raw HTML nodes instead of rendering author markup.",
    },
    className: { control: "text" },
    components: { control: false },
    remarkPlugins: { control: false },
  },
  parameters: { layout: "padded" },
  args: { text, dense: false, skipHtml: false },
} satisfies Meta<typeof MarkdownContent>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};

export const RawHtmlVisible: Story = {
  args: {
    text: "Visible text <!-- automation marker --> <span>raw tag</span>",
  },
};

export const RawHtmlSkipped: Story = {
  args: {
    skipHtml: true,
    text: "Visible text <!-- automation marker --> <span>raw tag</span>",
  },
};

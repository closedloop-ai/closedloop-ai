import { CodeBlock } from "@repo/design-system/components/ui/primitives/code-block";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Primitives/Code Block",
  component: CodeBlock,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    filename: "session-table.tsx",
    code: "export function SessionTable() {\n  return <div>Sessions</div>;\n}",
  },
} satisfies Meta<typeof CodeBlock>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};

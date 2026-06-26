import type { Meta, StoryObj } from "@storybook/react";
import { ToolInputView } from "./tool-data-view";

const meta = {
  title: "App Core/Agents/Tool Data View",
  component: ToolInputView,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    toolName: "Write",
    input: {
      file_path:
        "packages/design-system/components/ui/composites/session-table.tsx",
      content: "export function SessionTable() {\n  return null;\n}",
    },
  },
} satisfies Meta<typeof ToolInputView>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};

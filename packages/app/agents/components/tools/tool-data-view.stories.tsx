import type { Meta, StoryObj } from "@storybook/react";
import { ToolInputView, ToolResponseView } from "./tool-data-view";

/**
 * Renders a tool's raw input or response matched to that tool, like a
 * terminal block or diff, without the card Tool Call Block wraps around it.
 */
const meta = {
  title: "Composites/Sessions/Trace/Tool Data View",
  component: ToolInputView,
  tags: ["autodocs"],
  argTypes: {
    toolName: {
      control: "text",
      description:
        "Selects the per-tool renderer. An `mcp__` prefix routes to the generic key/value grid.",
    },
    input: { control: "object" },
  },
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

export const Response: Story = {
  render: () => (
    <ToolResponseView
      response={{
        stdout: "Formatted 42 files in 2.3s\n",
        stderr: "",
        exitCode: 0,
      }}
      toolName="Bash"
    />
  ),
};

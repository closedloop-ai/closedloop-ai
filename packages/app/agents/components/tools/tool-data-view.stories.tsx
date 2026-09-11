import type { Meta, StoryObj } from "@storybook/react";
import { ToolInputView, ToolResponseView } from "./tool-data-view";

/**
 * Two renderers that turn a tool's raw input or response into a view matched
 * to that specific tool: a terminal block for a shell command, a diff for an
 * edit, a match list for a search, and a generic key and value grid for
 * anything else, including any MCP tool. Use these when you want just that
 * formatted content on its own, without the collapsible card and status
 * badge that Tool Call Block wraps around it. A response view expects the
 * same shape a tool actually returns, such as the output text, error text,
 * and exit code of a shell command.
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

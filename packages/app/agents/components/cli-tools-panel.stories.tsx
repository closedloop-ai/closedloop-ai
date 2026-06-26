import { cliTools } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { CliToolsPanel } from "./cli-tools-panel";

function CliToolsPanelStory() {
  const [pathValues, setPathValues] = useState<Record<string, string>>(
    Object.fromEntries(cliTools.map((tool) => [tool.id, tool.path]))
  );

  return (
    <CliToolsPanel
      onPathChange={(toolId, value) =>
        setPathValues((current) => ({ ...current, [toolId]: value }))
      }
      onResetPath={(tool) =>
        setPathValues((current) => ({ ...current, [tool.id]: tool.path }))
      }
      onSavePath={() => undefined}
      pathValues={pathValues}
      tools={cliTools}
    />
  );
}

const meta = {
  title: "App Core/Agents/Cli Tools Panel",
  component: CliToolsPanelStory,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof CliToolsPanelStory>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};

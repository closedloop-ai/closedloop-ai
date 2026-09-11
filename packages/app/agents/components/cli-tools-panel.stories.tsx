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

/**
 * A grid of cards, one per command line tool the app can detect, each
 * showing its name, a status badge such as Detected, Not found, or Invalid
 * path, and an input where you can type or correct the path to that tool.
 * Save and Reset buttons sit beside the input, and a short hint line
 * explains what the current status means. Reach for it wherever someone
 * needs to point the app at a coding tool manually, because automatic
 * detection does not always find a tool installed somewhere unusual.
 */
const meta = {
  title: "Composites/Agents/Cli Tools Panel",
  component: CliToolsPanelStory,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof CliToolsPanelStory>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};

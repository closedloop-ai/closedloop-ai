import type { Meta, StoryObj } from "@storybook/react";
import { Code2Icon, MonitorIcon, UsersIcon } from "lucide-react";
import { expect, userEvent, within } from "storybook/test";
import { PrototypeScenarioPanel } from "./prototype-scenario-panel";

/**
 * ISS-12518: the declarative conditions list every prototype's reviewer
 * controls are built from. `web-master`'s developer menu is the first
 * caller; see `packages/app/shell/v2/components/web-master-preview/components/prototype-developer-menu.tsx`.
 */
const meta = {
  title: "Composites/Shared/Prototype Tools/Prototype Scenario Panel",
  component: PrototypeScenarioPanel,
  tags: ["experimental", "autodocs"],
  // No controls: every prop is a fixture (storage keys, labels, the conditions list).
  parameters: { layout: "fullscreen" },
  args: {
    ariaLabel: "Prototype developer controls",
    positionStorageKey: "storybook-prototype-scenario-panel-position",
    conditions: [
      {
        ariaLabel: "Prototype mode",
        default: "desktop",
        icon: Code2Icon,
        id: "mode",
        label: "Mode:",
        options: [
          {
            ariaLabel: "Desktop mode",
            icon: MonitorIcon,
            label: "Desktop",
            value: "desktop",
          },
          { ariaLabel: "Web mode", label: "Web", value: "web" },
        ],
        storageKey: "storybook-prototype-scenario-panel-mode",
      },
      {
        ariaLabel: "Prototype user position",
        default: "first-user",
        icon: UsersIcon,
        id: "user-scenario",
        label: "User:",
        options: [
          { ariaLabel: "First user", label: "First user", value: "first-user" },
          { ariaLabel: "51st user", label: "51st user", value: "51st-user" },
        ],
        storageKey: "storybook-prototype-scenario-panel-user",
      },
    ],
  },
} satisfies Meta<typeof PrototypeScenarioPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A single condition: the panel's first row doubles as the drag handle. */
export const SingleCondition: Story = {
  args: { conditions: meta.args.conditions.slice(0, 1) },
};

/** Caller-supplied footer actions render after the built-in Reset control. */
export const WithActions: Story = {
  args: {
    actions: [
      { label: "Simulate sync choice in Desktop", onClick: () => undefined },
    ],
  },
};

export const SelectAndReset: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("radio", { name: "Web mode" }));
    await expect(canvas.getByRole("radio", { name: "Web mode" })).toBeChecked();

    await userEvent.click(canvas.getByRole("button", { name: "Reset" }));
    await expect(
      canvas.getByRole("radio", { name: "Desktop mode" })
    ).toBeChecked();
  },
};

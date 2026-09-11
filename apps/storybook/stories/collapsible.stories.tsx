import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import type { Meta, StoryObj } from "@storybook/react";
import { Info } from "lucide-react";
import { fn } from "storybook/test";

/**
 * A bare expand and collapse primitive with a trigger and a content region,
 * used when building a custom expandable pattern rather than a ready made
 * Collapsible Section.
 */
const meta: Meta<typeof Collapsible> = {
  title: "Primitives/Layout/Collapsible",
  component: Collapsible,
  tags: ["autodocs"],
  argTypes: {
    open: {
      control: "boolean",
      description: "Controlled open state. Leave unset to use `defaultOpen`.",
    },
    defaultOpen: {
      control: "boolean",
      description: "Initial open state when the collapsible is uncontrolled.",
    },
    disabled: { control: "boolean" },
    className: { control: "text" },
    children: { control: false },
    onOpenChange: { control: false, table: { category: "Events" } },
  },
  args: {
    className: "w-96",
    defaultOpen: false,
    disabled: false,
    onOpenChange: fn(),
  },
  render: (args) => (
    <Collapsible {...args}>
      <CollapsibleTrigger className="flex gap-2">
        <h3 className="font-semibold">Can I use this in my project?</h3>
        <Info className="size-6" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        Yes. Free to use for personal and commercial projects. No attribution
        required.
      </CollapsibleContent>
    </Collapsible>
  ),
  parameters: {
    layout: "centered",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the collapsible.
 */
export const Default: Story = {};

/**
 * Use the `disabled` prop to disable the interaction.
 */
export const Disabled: Story = {
  args: {
    disabled: true,
  },
};

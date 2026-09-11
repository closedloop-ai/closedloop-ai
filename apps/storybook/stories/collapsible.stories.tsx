import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import type { Meta, StoryObj } from "@storybook/react";
import { Info } from "lucide-react";
import { fn } from "storybook/test";

/**
 * A bare expand and collapse primitive: a trigger you click and a content
 * region that shows or hides underneath it, with no header styling of its
 * own. Reach for this when you are building a custom expandable pattern. For
 * a ready-made section with a title, chevron and open state already wired
 * up, use Collapsible Section instead, or Sidebar Collapsible Section inside
 * a sidebar. It can run controlled with the open prop or uncontrolled with
 * defaultOpen, and the disabled prop stops the trigger from responding at
 * all.
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

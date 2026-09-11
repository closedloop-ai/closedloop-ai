import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import type { Meta, StoryObj } from "@storybook/react";
import { Bold, Italic, Underline } from "lucide-react";
import { expect, fn, userEvent, within } from "storybook/test";

/**
 * A row of buttons acting as one control, like a formatting toolbar, used
 * instead of a plain button group whenever the pressed state is the value
 * itself.
 */
const meta: Meta<typeof ToggleGroup> = {
  title: "Composites/Inputs/Toggle Group",
  component: ToggleGroup,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      options: ["default", "outline"],
      control: { type: "radio" },
      table: { category: "Appearance" },
    },
    size: {
      options: ["default", "sm", "lg"],
      control: { type: "radio" },
      table: { category: "Appearance" },
    },
    spacing: {
      control: { type: "number", min: 0, max: 8, step: 1 },
      table: { category: "Appearance" },
      description: "Gap between items, in spacing-scale units.",
    },
    type: {
      options: ["multiple", "single"],
      control: { type: "radio" },
      table: { category: "State" },
    },
    disabled: {
      control: "boolean",
      table: { category: "State" },
    },
    orientation: {
      options: ["horizontal", "vertical"],
      control: { type: "radio" },
      table: { category: "State" },
    },
    // Selection shape follows `type` (a string for single, a string array for
    // multiple), so editing it from the panel can hand Radix the wrong shape.
    value: { control: false, table: { category: "State" } },
    defaultValue: { control: false, table: { category: "State" } },
    children: { control: false, table: { category: "Content" } },
    onValueChange: { control: false, table: { category: "Events" } },
  },
  args: {
    variant: "default",
    size: "default",
    spacing: 0,
    type: "multiple",
    orientation: "horizontal",
    disabled: false,
    onValueChange: fn(),
  },
  render: (args) => (
    <ToggleGroup {...args}>
      <ToggleGroupItem aria-label="Toggle bold" value="bold">
        <Bold className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem aria-label="Toggle italic" value="italic">
        <Italic className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem aria-label="Toggle underline" value="underline">
        <Underline className="h-4 w-4" />
      </ToggleGroupItem>
    </ToggleGroup>
  ),
  parameters: {
    layout: "centered",
  },
};

export default meta;

type Story = StoryObj<typeof ToggleGroup>;

/**
 * The default form of the toggle group.
 */
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const bold = canvas.getByRole("button", { name: "Toggle bold" });

    await userEvent.click(bold);

    await expect(bold).toHaveAttribute("aria-pressed", "true");
    await expect(args.onValueChange).toHaveBeenCalledWith(["bold"]);
  },
};

/**
 * Every `variant` value rendered side by side, labelled, so one Chromatic
 * snapshot keeps visual coverage of the full set instead of one story per
 * value. Drive `variant` from the Controls panel on Default to preview a
 * single value in isolation.
 */
export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-6">
      {(["default", "outline"] as const).map((variant) => (
        <div className="flex flex-col items-center gap-2" key={variant}>
          <span className="text-muted-foreground text-xs">{variant}</span>
          <ToggleGroup type="multiple" variant={variant}>
            <ToggleGroupItem aria-label="Toggle bold" value="bold">
              <Bold className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Toggle italic" value="italic">
              <Italic className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Toggle underline" value="underline">
              <Underline className="h-4 w-4" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      ))}
    </div>
  ),
};

/**
 * Every `size` value rendered side by side, labelled, so one Chromatic
 * snapshot keeps visual coverage of the full set instead of one story per
 * value. Drive `size` from the Controls panel on Default to preview a single
 * value in isolation.
 */
export const AllSizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-6">
      {(["default", "sm", "lg"] as const).map((size) => (
        <div className="flex flex-col items-center gap-2" key={size}>
          <span className="text-muted-foreground text-xs">{size}</span>
          <ToggleGroup size={size} type="multiple">
            <ToggleGroupItem aria-label="Toggle bold" value="bold">
              <Bold className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Toggle italic" value="italic">
              <Italic className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Toggle underline" value="underline">
              <Underline className="h-4 w-4" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      ))}
    </div>
  ),
};

/**
 * Use the `single` type to create exclusive selection within the button
 * group, allowing only one button to be active at a time.
 */
export const Single: Story = {
  args: {
    type: "single",
  },
};

/**
 * Add the `disabled` prop to a button to prevent interactions.
 */
export const Disabled: Story = {
  args: {
    disabled: true,
  },
};

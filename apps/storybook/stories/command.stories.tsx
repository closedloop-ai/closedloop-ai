import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import type { Meta, StoryObj } from "@storybook/react";
import { CommandSeparator } from "cmdk";
import { fn } from "storybook/test";

/**
 * A searchable list of items with a text box at the top: type to filter,
 * then use the arrow keys and Enter to pick one. Reach for it whenever
 * people need to find one item out of many by typing rather than scrolling,
 * most often as a command palette opened with a keyboard shortcut, but also
 * as the list inside a search dropdown or combobox. Filtering, ranking, and
 * keyboard navigation are built in, but grouping items into sections and
 * showing an empty results message are both left for you to add. Hand it a
 * list you have already filtered or ranked yourself and turn off its built
 * in filtering, or its own text matching will filter your list a second
 * time.
 */
const meta = {
  title: "Composites/Overlays/Command",
  component: Command,
  tags: ["autodocs"],
  argTypes: {
    label: {
      control: "text",
      description: "Accessible label for the menu. Not shown visually.",
      table: { category: "Content" },
    },
    children: { control: false, table: { category: "Content" } },
    className: { control: "text", table: { category: "Appearance" } },
    asChild: {
      control: false,
      description: "Render the child element instead of a div.",
      table: { category: "Appearance" },
    },
    shouldFilter: {
      control: "boolean",
      description: "Let cmdk filter and rank items against the search query.",
      table: { category: "Behavior" },
    },
    loop: {
      control: "boolean",
      description: "Wrap around when arrowing past the first or last item.",
      table: { category: "Behavior" },
    },
    vimBindings: {
      control: "boolean",
      description: "Enable the ctrl+n/j/p/k navigation shortcuts.",
      table: { category: "Behavior" },
    },
    disablePointerSelection: {
      control: "boolean",
      description: "Stop pointer movement from changing the selected item.",
      table: { category: "Behavior" },
    },
    filter: {
      control: false,
      description: "Custom scoring function replacing the default matcher.",
      table: { category: "Behavior" },
    },
    value: {
      control: "text",
      description: "Controlled value of the selected item.",
      table: { category: "State" },
    },
    defaultValue: {
      control: "text",
      description: "Value selected on first render.",
      table: { category: "State" },
    },
    onValueChange: { control: false, table: { category: "Events" } },
  },
  args: {
    className: "rounded-lg w-96 border shadow-md",
    disablePointerSelection: false,
    label: "Command menu",
    loop: false,
    onValueChange: fn(),
    shouldFilter: true,
    vimBindings: true,
  },
  render: (args) => (
    <Command {...args}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Suggestions">
          <CommandItem>Calendar</CommandItem>
          <CommandItem>Search Emoji</CommandItem>
          <CommandItem>Calculator</CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Settings">
          <CommandItem>Profile</CommandItem>
          <CommandItem>Billing</CommandItem>
          <CommandItem>Settings</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  ),
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Command>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the command.
 */
export const Default: Story = {};

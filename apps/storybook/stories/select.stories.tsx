import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * Displays a list of options for the user to pick from—triggered by a button.
 */
const meta: Meta<typeof Select> = {
  title: "Design System/Primitives/Select",
  component: Select,
  tags: ["autodocs"],
  argTypes: {
    defaultValue: {
      options: [
        "apple",
        "banana",
        "blueberry",
        "grapes",
        "pineapple",
        "aubergine",
        "broccoli",
        "carrot",
        "courgette",
        "leek",
        "beef",
        "chicken",
        "lamb",
        "pork",
      ],
      control: { type: "select" },
      description: "Initial selection when the select is left uncontrolled.",
      table: { category: "State" },
    },
    value: {
      control: false,
      description:
        "Controlled selection. Pair it with onValueChange or the select cannot change.",
      table: { category: "State" },
    },
    open: {
      control: false,
      description: "Controlled open state. Pair it with onOpenChange.",
      table: { category: "State" },
    },
    defaultOpen: {
      control: "boolean",
      table: { category: "State" },
    },
    dir: {
      options: ["ltr", "rtl"],
      control: { type: "radio" },
      table: { category: "Appearance" },
    },
    disabled: {
      control: "boolean",
      table: { category: "Form" },
    },
    required: {
      control: "boolean",
      table: { category: "Form" },
    },
    name: {
      control: "text",
      description: "Field name submitted with the surrounding form.",
      table: { category: "Form" },
    },
    autoComplete: {
      control: "text",
      table: { category: "Form" },
    },
    form: {
      control: "text",
      description: "Id of a form elsewhere in the document to submit with.",
      table: { category: "Form" },
    },
    onValueChange: {
      control: false,
      table: { category: "Events" },
    },
    onOpenChange: {
      control: false,
      table: { category: "Events" },
    },
  },
  args: {
    defaultOpen: false,
    disabled: false,
    required: false,
    onValueChange: fn(),
    onOpenChange: fn(),
  },
  render: (args) => (
    <Select {...args}>
      <SelectTrigger className="w-96">
        <SelectValue placeholder="Select a fruit" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Fruits</SelectLabel>
          <SelectItem value="apple">Apple</SelectItem>
          <SelectItem value="banana">Banana</SelectItem>
          <SelectItem value="blueberry">Blueberry</SelectItem>
          <SelectItem value="grapes">Grapes</SelectItem>
          <SelectItem value="pineapple">Pineapple</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Vegetables</SelectLabel>
          <SelectItem value="aubergine">Aubergine</SelectItem>
          <SelectItem value="broccoli">Broccoli</SelectItem>
          <SelectItem disabled value="carrot">
            Carrot
          </SelectItem>
          <SelectItem value="courgette">Courgette</SelectItem>
          <SelectItem value="leek">Leek</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Meat</SelectLabel>
          <SelectItem value="beef">Beef</SelectItem>
          <SelectItem value="chicken">Chicken</SelectItem>
          <SelectItem value="lamb">Lamb</SelectItem>
          <SelectItem value="pork">Pork</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Select>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the select.
 */
export const Default: Story = {};

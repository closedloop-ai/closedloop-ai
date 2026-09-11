import { Input } from "@repo/design-system/components/ui/input";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * A single line text box for typing a value like an email or password, with
 * the type prop switching keyboard behaviour, used instead of Textarea for
 * short entries.
 */
const meta = {
  title: "Primitives/Inputs/Input",
  component: Input,
  tags: ["autodocs"],
  argTypes: {
    type: {
      options: [
        "text",
        "email",
        "password",
        "number",
        "search",
        "tel",
        "url",
        "date",
        "file",
      ],
      control: { type: "select" },
      table: { category: "Content" },
    },
    placeholder: { control: "text", table: { category: "Content" } },
    defaultValue: { control: "text", table: { category: "Content" } },
    className: { control: "text", table: { category: "Appearance" } },
    disabled: { control: "boolean", table: { category: "State" } },
    readOnly: { control: "boolean", table: { category: "State" } },
    required: { control: "boolean", table: { category: "State" } },
    onChange: { control: false, table: { category: "Events" } },
    onFocus: { control: false, table: { category: "Events" } },
    onBlur: { control: false, table: { category: "Events" } },
  },
  args: {
    className: "w-96",
    type: "email",
    placeholder: "Email",
    disabled: false,
    readOnly: false,
    required: false,
    onChange: fn(),
    onFocus: fn(),
    onBlur: fn(),
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Input>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the input field.
 */
export const Default: Story = {};

/**
 * Use the `disabled` prop to make the input non-interactive and appears faded,
 * indicating that input is not currently accepted.
 */
export const Disabled: Story = {
  args: { disabled: true },
};

/**
 * Use the `Label` component to includes a clear, descriptive label above or
 * alongside the input area to guide users.
 */
export const WithLabel: Story = {
  render: (args) => (
    <div className="grid items-center gap-1.5">
      <label htmlFor="email">{args.placeholder}</label>
      <Input {...args} id="email" />
    </div>
  ),
};

/**
 * Use a text element below the input field to provide additional instructions
 * or information to users.
 */
export const WithHelperText: Story = {
  render: (args) => (
    <div className="grid items-center gap-1.5">
      <label htmlFor="email-2">{args.placeholder}</label>
      <Input {...args} id="email-2" />
      <p className="text-foreground/50 text-sm">Enter your email address.</p>
    </div>
  ),
};

/**
 * Use the `Button` component to indicate that the input field can be submitted
 * or used to trigger an action.
 */
export const WithButton: Story = {
  render: (args) => (
    <div className="flex items-center space-x-2">
      <Input {...args} />
      <button
        className="rounded bg-primary px-4 py-2 text-primary-foreground"
        type="submit"
      >
        Subscribe
      </button>
    </div>
  ),
};

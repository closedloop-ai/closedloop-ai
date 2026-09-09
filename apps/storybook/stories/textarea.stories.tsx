import { Textarea } from "@repo/design-system/components/ui/textarea";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * Displays a form textarea or a component that looks like a textarea.
 */
const meta = {
  title: "Design System/Primitives/Textarea",
  component: Textarea,
  tags: ["autodocs"],
  argTypes: {
    placeholder: {
      control: "text",
      table: { category: "Content" },
    },
    rows: {
      control: { type: "number", min: 1, max: 20, step: 1 },
      table: { category: "Content" },
      description: "Visible line count before the field starts scrolling.",
    },
    disabled: {
      control: "boolean",
      table: { category: "State" },
    },
    readOnly: {
      control: "boolean",
      table: { category: "State" },
    },
    required: {
      control: "boolean",
      table: { category: "State" },
    },
    onChange: { control: false, table: { category: "Events" } },
    onFocus: { control: false, table: { category: "Events" } },
    onBlur: { control: false, table: { category: "Events" } },
  },
  args: {
    placeholder: "Type your message here.",
    rows: 4,
    disabled: false,
    readOnly: false,
    required: false,
    onBlur: fn(),
    onChange: fn(),
    onFocus: fn(),
  },
} satisfies Meta<typeof Textarea>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the textarea.
 */
export const Default: Story = {};

/**
 * Use the `disabled` prop to disable the textarea.
 */
export const Disabled: Story = {
  args: {
    disabled: true,
  },
};

/**
 * Use the `Label` component to includes a clear, descriptive label above or
 * alongside the text area to guide users.
 */
export const WithLabel: Story = {
  render: (args) => (
    <div className="grid w-full gap-1.5">
      <label htmlFor="message">Your message</label>
      <Textarea {...args} id="message" />
    </div>
  ),
};

/**
 * Use a text element below the text area to provide additional instructions
 * or information to users.
 */
export const WithText: Story = {
  render: (args) => (
    <div className="grid w-full gap-1.5">
      <label htmlFor="message-2">Your Message</label>
      <Textarea {...args} id="message-2" />
      <p className="text-slate-500 text-sm">
        Your message will be copied to the support team.
      </p>
    </div>
  ),
};

/**
 * Use the `Button` component to indicate that the text area can be submitted
 * or used to trigger an action.
 */
export const WithButton: Story = {
  render: (args) => (
    <div className="grid w-full gap-2">
      <Textarea {...args} />
      <button
        className="rounded bg-primary px-4 py-2 text-primary-foreground"
        type="submit"
      >
        Send Message
      </button>
    </div>
  ),
};

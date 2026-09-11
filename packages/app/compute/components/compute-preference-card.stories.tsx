import type { Meta, StoryObj } from "@storybook/react";
import { CloudIcon, ContainerIcon } from "lucide-react";
import { fn } from "storybook/test";
import {
  ComputePreferenceCard,
  type ComputePreferenceOption,
} from "./compute-preference-card";

const options: ComputePreferenceOption[] = [
  {
    value: "cloud",
    label: "Cloud",
    description: "Runs in dedicated ECS containers with real-time streaming",
    icon: <CloudIcon className="h-4 w-4 text-blue-600" />,
  },
  {
    value: "local",
    label: "Local",
    description: "Runs on your registered desktop agent",
    icon: <ContainerIcon className="h-4 w-4" />,
  },
];

/**
 * A card with a title, a description, and a set of radio options, each with
 * its own icon and one-line explanation, for choosing where AI agent jobs
 * run, such as in the cloud or on your local desktop. Use it for a single
 * either-or setting where each choice needs a sentence of explanation, not
 * just a label. While the current value is loading, the whole options list
 * is replaced by a spinner rather than showing empty or stale radio buttons.
 */
const meta = {
  title: "Composites/Compute/Compute Preference Card",
  component: ComputePreferenceCard,
  tags: ["autodocs"],
  argTypes: {
    description: { control: "text", table: { category: "Content" } },
    disabled: { control: "boolean", table: { category: "State" } },
    headerIcon: { control: false, table: { category: "Content" } },
    isLoading: {
      control: "boolean",
      description: "Replaces the radio group with a spinner.",
      table: { category: "State" },
    },
    onValueChange: { control: false, table: { category: "Events" } },
    options: {
      control: false,
      description:
        "Each option carries a value, label, description and icon node.",
      table: { category: "Data" },
    },
    title: { control: "text", table: { category: "Content" } },
    value: {
      control: { type: "radio" },
      options: options.map((option) => option.value),
      table: { category: "State" },
    },
  },
  args: {
    title: "Compute Mode",
    description:
      "Choose where AI agent jobs run. Cloud uses Closedloop infrastructure. Local routes jobs to your registered desktop agent.",
    disabled: false,
    headerIcon: <ContainerIcon className="h-5 w-5" />,
    isLoading: false,
    options,
    value: "cloud",
    onValueChange: fn(),
  },
} satisfies Meta<typeof ComputePreferenceCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    isLoading: true,
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
    value: "local",
  },
};

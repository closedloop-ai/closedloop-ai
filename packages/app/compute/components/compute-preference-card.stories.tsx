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

const meta = {
  title: "App Core/Compute/Compute Preference Card",
  component: ComputePreferenceCard,
  args: {
    title: "Compute Mode",
    description:
      "Choose where AI agent jobs run. Cloud uses Closedloop infrastructure. Local routes jobs to your registered desktop agent.",
    headerIcon: <ContainerIcon className="h-5 w-5" />,
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

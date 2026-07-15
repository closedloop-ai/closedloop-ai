import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import type { Meta, StoryObj } from "@storybook/react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  Info as InfoIcon,
} from "lucide-react";

/**
 * Displays a callout for user attention.
 */
const meta = {
  title: "Design System/Primitives/Alert",
  component: Alert,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      options: [
        "default",
        "destructive",
        "error",
        "warning",
        "info",
        "success",
      ],
      control: { type: "radio" },
    },
  },
  args: {
    variant: "default",
  },
  render: (args) => (
    <Alert {...args}>
      <AlertTitle>Heads up!</AlertTitle>
      <AlertDescription>
        You can add components to your app using the cli.
      </AlertDescription>
    </Alert>
  ),
} satisfies Meta<typeof Alert>;

export default meta;

type Story = StoryObj<typeof meta>;
/**
 * The default form of the alert.
 */
export const Default: Story = {};

/**
 * Use the `destructive` alert to indicate a destructive action.
 */
export const Destructive: Story = {
  render: (args) => (
    <Alert {...args}>
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Error</AlertTitle>
      <AlertDescription>
        Your session has expired. Please log in again.
      </AlertDescription>
    </Alert>
  ),
  args: {
    variant: "destructive",
  },
};

/**
 * The tinted `error` alert for surfacing failures inline.
 */
export const ErrorAlert: Story = {
  render: (args) => (
    <Alert {...args}>
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription>
        We couldn't load your data. Please try again.
      </AlertDescription>
    </Alert>
  ),
  args: {
    variant: "error",
  },
};

/**
 * Use the `warning` alert to flag a non-blocking caution.
 */
export const Warning: Story = {
  render: (args) => (
    <Alert {...args}>
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Heads up</AlertTitle>
      <AlertDescription>
        This action can't be undone once confirmed.
      </AlertDescription>
    </Alert>
  ),
  args: {
    variant: "warning",
  },
};

/**
 * Use the `info` alert to convey neutral, contextual information.
 */
export const InfoAlert: Story = {
  render: (args) => (
    <Alert {...args}>
      <InfoIcon className="h-4 w-4" />
      <AlertTitle>Good to know</AlertTitle>
      <AlertDescription>
        Changes are saved automatically as you edit.
      </AlertDescription>
    </Alert>
  ),
  args: {
    variant: "info",
  },
};

/**
 * Use the `success` alert to confirm a completed action.
 */
export const Success: Story = {
  render: (args) => (
    <Alert {...args}>
      <CheckCircle className="h-4 w-4" />
      <AlertTitle>All set</AlertTitle>
      <AlertDescription>Your changes have been saved.</AlertDescription>
    </Alert>
  ),
  args: {
    variant: "success",
  },
};

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
 * A boxed callout with a title, description, and optional icon for a message
 * that needs attention without blocking work, use Friendly Error Alert
 * instead for a raw error object.
 */
const meta = {
  title: "Primitives/Feedback & Status/Alert",
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

type AlertVariant = (typeof meta)["args"]["variant"];

const ALL_VARIANTS: {
  variant: AlertVariant;
  icon: typeof AlertCircle | null;
  title: string;
  description: string;
}[] = [
  {
    variant: "default",
    icon: null,
    title: "Heads up!",
    description: "You can add components to your app using the cli.",
  },
  {
    variant: "destructive",
    icon: AlertCircle,
    title: "Error",
    description: "Your session has expired. Please log in again.",
  },
  {
    variant: "error",
    icon: AlertCircle,
    title: "Something went wrong",
    description: "We couldn't load your data. Please try again.",
  },
  {
    variant: "warning",
    icon: AlertTriangle,
    title: "Heads up",
    description: "This action can't be undone once confirmed.",
  },
  {
    variant: "info",
    icon: InfoIcon,
    title: "Good to know",
    description: "Changes are saved automatically as you edit.",
  },
  {
    variant: "success",
    icon: CheckCircle,
    title: "All set",
    description: "Your changes have been saved.",
  },
];

/**
 * Every `variant` value rendered together, each labelled. The individual
 * variant stories were pure style permutations of the same alert, so this one
 * story keeps a single Chromatic snapshot covering all of them instead of one
 * snapshot per variant. Drive a single variant through the Controls panel on
 * the Default story above.
 */
export const AllVariants: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {ALL_VARIANTS.map(({ variant, icon: Icon, title, description }) => (
        <div
          key={variant}
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <span style={{ fontSize: 11 }}>{variant}</span>
          <Alert variant={variant}>
            {Icon ? <Icon className="h-4 w-4" /> : null}
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription>{description}</AlertDescription>
          </Alert>
        </div>
      ))}
    </div>
  ),
};

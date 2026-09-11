import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import type { Meta, StoryObj } from "@storybook/react";
import { BellRing } from "lucide-react";

const notifications = [
  {
    title: "Your call has been confirmed.",
    description: "1 hour ago",
  },
  {
    title: "You have a new message!",
    description: "1 hour ago",
  },
  {
    title: "Your subscription is expiring soon!",
    description: "2 hours ago",
  },
];

/**
 * A bordered, rounded container that groups related content, built from
 * separate header, content and footer pieces you compose together as needed.
 * Use it to group a self-contained block of information, like a notification
 * list or a settings panel, rather than as a general page wrapper. It has no
 * built-in title, scroll, or collapse behaviour: add those yourself with
 * something like Section Header or Scroll Area when you need them.
 */
const meta = {
  title: "Primitives/Layout/Card",
  component: Card,
  tags: ["autodocs"],
  argTypes: {
    className: { control: "text" },
    children: {
      control: false,
      description:
        "Card content. This story renders a fixed header, content, and footer.",
    },
  },
  args: {
    className: "w-96",
  },
  render: (args) => (
    <Card {...args}>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>You have 3 unread messages.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {notifications.map((notification) => (
          <div className="flex items-center gap-4" key={notification.title}>
            <BellRing className="size-6" />
            <div>
              <p>{notification.title}</p>
              <p className="text-foreground/50">{notification.description}</p>
            </div>
          </div>
        ))}
      </CardContent>
      <CardFooter>
        <button className="hover:underline" type="button">
          Close
        </button>
      </CardFooter>
    </Card>
  ),
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Card>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the card.
 */
export const Default: Story = {};

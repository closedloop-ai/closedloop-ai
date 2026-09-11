import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";

/**
 * A row of buttons that switch between panels of content, with the active
 * tab filled solid, the default choice over the lighter Underline Tabs on a
 * full width header.
 */
const meta: Meta<typeof Tabs> = {
  title: "Primitives/Navigation/Tabs",
  component: Tabs,
  tags: ["autodocs"],
  argTypes: {
    defaultValue: {
      control: "text",
      description: "Tab selected on first render while uncontrolled.",
    },
    value: {
      control: false,
      description:
        "Controlled selected tab. The default canvas drives this from local state, so it is not an arg here.",
    },
    orientation: {
      options: ["horizontal", "vertical"],
      control: { type: "radio" },
    },
    dir: {
      options: ["ltr", "rtl"],
      control: { type: "radio" },
    },
    activationMode: {
      options: ["automatic", "manual"],
      control: { type: "radio" },
      description:
        "Whether arrowing onto a tab selects it or the user has to confirm with Enter or Space.",
    },
    className: { control: "text" },
    onValueChange: { control: false, table: { category: "Events" } },
  },
  args: {
    defaultValue: "account",
    className: "w-96",
    orientation: "horizontal",
    activationMode: "automatic",
    onValueChange: fn(),
  },
  render: (args) => {
    function TabsCanvas() {
      const [value, setValue] = useState(args.defaultValue);

      return (
        <div className="space-y-3">
          <Tabs {...args} onValueChange={setValue} value={value}>
            <TabsList className="grid grid-cols-2">
              <TabsTrigger value="account">Account</TabsTrigger>
              <TabsTrigger value="password">Password</TabsTrigger>
            </TabsList>
            <TabsContent value="account">
              Make changes to your account here.
            </TabsContent>
            <TabsContent value="password">
              Change your password here.
            </TabsContent>
          </Tabs>
          <p className="text-muted-foreground text-sm">Selected tab: {value}</p>
        </div>
      );
    }

    return <TabsCanvas />;
  },
  parameters: {
    layout: "centered",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the tabs.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole("tab", { name: "Password" }));

    // The render wires `onValueChange` to local state rather than passing
    // `args.onValueChange` through, so the visible outcome is the seam to
    // check here rather than the mock.
    await expect(
      await canvas.findByText("Change your password here.")
    ).toBeVisible();
    await expect(canvas.getByText("Selected tab: password")).toBeVisible();
  },
};

export const DisabledTrigger: Story = {
  render: (args) => (
    <Tabs {...args} defaultValue="account">
      <TabsList className="grid grid-cols-3">
        <TabsTrigger value="account">Account</TabsTrigger>
        <TabsTrigger disabled value="billing">
          Billing
        </TabsTrigger>
        <TabsTrigger value="password">Password</TabsTrigger>
      </TabsList>
      <TabsContent value="account">Account settings content.</TabsContent>
      <TabsContent value="billing">Billing content.</TabsContent>
      <TabsContent value="password">Password settings content.</TabsContent>
    </Tabs>
  ),
};

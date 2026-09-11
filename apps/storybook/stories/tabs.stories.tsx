import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";

/**
 * A row of buttons that switch between panels of content, showing one panel
 * at a time, with the active tab filled in solid. Use it as the default
 * choice for switching sections of a page or panel; reach for Underline Tabs
 * instead when the tabs sit on a full width header and you want a lighter
 * mark under the active one rather than a filled pill. It also works stacked
 * vertically and right to left, and you can choose whether arrowing onto a
 * tab selects it right away or waits for you to press Enter or Space. A tab
 * can be individually disabled, which skips it during keyboard navigation.
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
export const Default: Story = {};

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

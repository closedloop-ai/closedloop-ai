import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

/**
 * A set of layered sections of content—known as tab panels—that are displayed
 * one at a time.
 */
const meta: Meta<typeof Tabs> = {
  title: "Design System/Navigation & Shell/Tabs",
  component: Tabs,
  tags: ["autodocs"],
  argTypes: {},
  args: {
    defaultValue: "account",
    className: "w-96",
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

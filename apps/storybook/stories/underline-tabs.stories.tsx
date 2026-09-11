import {
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@repo/design-system/components/ui/primitives/underline-tabs";
import { Tabs, TabsContent } from "@repo/design-system/components/ui/tabs";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

const UnderlineTabsCanvas = () => {
  const [tab, setTab] = useState("overview");
  return (
    <Tabs className="w-full max-w-2xl" onValueChange={setTab} value={tab}>
      <UnderlineTabsList>
        <UnderlineTabsTrigger value="overview">Overview</UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="activity">Artifacts</UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="settings">Workflows</UnderlineTabsTrigger>
      </UnderlineTabsList>
      <TabsContent className="p-4 text-sm" value="overview">
        Summary metrics and ownership details.
      </TabsContent>
      <TabsContent className="p-4 text-sm" value="activity">
        Artifact groups, filters, and favorites.
      </TabsContent>
      <TabsContent className="p-4 text-sm" value="settings">
        Workflow activity and execution state.
      </TabsContent>
      <p className="px-4 pb-4 text-muted-foreground text-sm">
        Active tab: {tab}
      </p>
    </Tabs>
  );
};

/**
 * A row of tabs where the active one is marked with an underline instead of
 * a filled background, sitting on a full width border like a browser's tab
 * strip. Reach for it on a page or panel header where the sections deserve
 * equal visual weight, instead of the pill style Tabs when a heavier switch
 * control would compete with the content below it. It is built on that same
 * Tabs component underneath, so it manages state, keyboard navigation, and
 * content panels the same way; the underline is only a style change on the
 * tab list and its triggers.
 */
const meta = {
  title: "Composites/Navigation/Underline Tabs",
  component: UnderlineTabsCanvas,
  tags: ["autodocs"],
} satisfies Meta<typeof UnderlineTabsCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ManyTabs: Story = {
  render: () => {
    const [tab, setTab] = useState("overview");

    return (
      <Tabs className="w-full max-w-3xl" onValueChange={setTab} value={tab}>
        <UnderlineTabsList>
          <UnderlineTabsTrigger value="overview">Overview</UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="artifacts">
            Artifacts
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="workflows">
            Workflows
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="activity">Activity</UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="settings">Settings</UnderlineTabsTrigger>
        </UnderlineTabsList>
        <TabsContent className="p-4 text-sm" value="overview">
          Overview content
        </TabsContent>
        <TabsContent className="p-4 text-sm" value="artifacts">
          Artifact content
        </TabsContent>
        <TabsContent className="p-4 text-sm" value="workflows">
          Workflow content
        </TabsContent>
        <TabsContent className="p-4 text-sm" value="activity">
          Activity content
        </TabsContent>
        <TabsContent className="p-4 text-sm" value="settings">
          Settings content
        </TabsContent>
      </Tabs>
    );
  },
};

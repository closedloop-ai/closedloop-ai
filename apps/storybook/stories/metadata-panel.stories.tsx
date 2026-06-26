import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  MetadataPanel,
  MetadataSection,
  TabbedMetadataPanel,
} from "@repo/design-system/components/ui/metadata-panel";
import type { Meta, StoryObj } from "@storybook/react";

const scrollSections = [
  "Overview",
  "Status",
  "Priority",
  "Assignee",
  "Linked artifacts",
  "Repository context",
  "Activity summary",
  "Recent changes",
] as const;

const meta = {
  title: "Design System/Primitives/Metadata Panel",
  component: MetadataPanel,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
  args: {
    children: <div />,
  },
} satisfies Meta<typeof MetadataPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Sidebar: Story = {
  render: () => (
    <MetadataPanel title="PRD Details">
      <MetadataSection>
        <Label>Status</Label>
        <Badge variant="secondary">In review</Badge>
      </MetadataSection>
      <MetadataSection separator>
        <Label htmlFor="owner">Owner</Label>
        <Input id="owner" readOnly value="Avery Carter" />
      </MetadataSection>
      <MetadataSection separator>
        <Button variant="outline">Manage relationships</Button>
      </MetadataSection>
    </MetadataPanel>
  ),
};

export const ScrollableSidebar: Story = {
  render: () => (
    <MetadataPanel className="h-[28rem]" title="Implementation Plan">
      {scrollSections.map((sectionLabel, index) => (
        <MetadataSection key={sectionLabel} separator={index > 0}>
          <Label>{`Section ${index + 1}`}</Label>
          <Input readOnly value={sectionLabel} />
          <p className="text-muted-foreground text-sm">
            Captures the denser sidebar layout used by document and plan
            surfaces in the product app.
          </p>
        </MetadataSection>
      ))}
    </MetadataPanel>
  ),
};

export const Bar: Story = {
  render: () => (
    <MetadataPanel variant="bar">
      <MetadataSection layout="horizontal">
        <Badge variant="secondary">In review</Badge>
        <Badge variant="outline">PRD</Badge>
        <Badge variant="outline">Priority: High</Badge>
        <Button size="sm" variant="outline">
          Attach files
        </Button>
      </MetadataSection>
    </MetadataPanel>
  ),
};

export const Tabbed: Story = {
  render: () => (
    <TabbedMetadataPanel
      defaultTab="details"
      tabs={[
        {
          id: "details",
          label: "Details",
          content: (
            <div className="space-y-4">
              <MetadataSection>
                <Label>Priority</Label>
                <Badge variant="outline">High</Badge>
              </MetadataSection>
              <MetadataSection separator>
                <Label>Assignee</Label>
                <Input readOnly value="Jordan Lee" />
              </MetadataSection>
            </div>
          ),
        },
        {
          id: "activity",
          label: "Activity",
          content: (
            <div className="space-y-2 text-muted-foreground text-sm">
              <p>Updated 8 minutes ago</p>
              <p>3 linked artifacts</p>
            </div>
          ),
        },
      ]}
    />
  ),
};

export const TabbedEmpty: Story = {
  render: () => (
    <TabbedMetadataPanel
      defaultTab="history"
      tabs={[
        {
          id: "history",
          label: "History",
          content: (
            <div className="rounded-lg border border-dashed p-4 text-muted-foreground text-sm">
              No activity has been recorded for this artifact yet.
            </div>
          ),
        },
        {
          id: "links",
          label: "Links",
          content: (
            <div className="rounded-lg border border-dashed p-4 text-muted-foreground text-sm">
              No related documents or pull requests are linked yet.
            </div>
          ),
        },
      ]}
    />
  ),
};

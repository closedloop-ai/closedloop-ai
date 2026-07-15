import { FeatureStatus } from "@repo/api/src/types/document";
import { FeatureStatusIcon } from "@repo/app/documents/components/feature-status-icon";
import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import type { Meta, StoryObj } from "@storybook/react";
import { FileCodeIcon, SparklesIcon } from "lucide-react";
import { ArtifactRowView } from "./artifact-row-view";

const meta = {
  title: "App Core/Documents/Artifact Row View",
  component: ArtifactRowView,
  tags: ["autodocs"],
  args: {
    assignee: (
      <Avatar className="size-6">
        <AvatarFallback>MA</AvatarFallback>
      </Avatar>
    ),
    depth: 1,
    href: "/acme/features/platform-shell",
    onDetach: () => undefined,
    priority: "HIGH",
    slug: "feature-shell",
    statusIcon: <FeatureStatusIcon status={FeatureStatus.InReview} />,
    statusLabel: "In review",
    title: "Platform shell convergence",
    typeIcon: (
      <FileCodeIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
    ),
    typeLabel: "Feature",
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof ArtifactRowView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ChildRow: Story = {
  args: {
    depth: 2,
    title: "Workflow visualization parity",
    slug: "workflow-viz",
    typeIcon: (
      <SparklesIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
    ),
    typeLabel: "Workflow",
  },
};

export const WithoutDetach: Story = {
  args: {
    href: null,
    onDetach: undefined,
  },
};

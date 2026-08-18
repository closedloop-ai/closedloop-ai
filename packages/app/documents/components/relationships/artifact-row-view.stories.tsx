import {
  DocumentType,
  IssueStatus,
  TYPE_ROUTE_PREFIX,
} from "@repo/api/src/types/document";
import { IssueStatusIcon } from "@repo/app/documents/components/issue-status-icon";
import { DOCUMENT_TYPE_LABELS } from "@repo/app/documents/lib/document-type-labels";
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
    // FEA-4137: the Feature subtype routes under /issues/ and displays as
    // "Issue". Read both from their canonical maps so this fixture cannot drift
    // back to the retired "Feature" vocabulary.
    href: `/acme/${TYPE_ROUTE_PREFIX[DocumentType.Feature]}/platform-shell`,
    onDetach: () => undefined,
    priority: "HIGH",
    slug: "platform-shell",
    statusIcon: <IssueStatusIcon status={IssueStatus.InReview} />,
    statusLabel: "In review",
    title: "Platform shell convergence",
    typeIcon: (
      <FileCodeIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
    ),
    typeLabel: DOCUMENT_TYPE_LABELS[DocumentType.Feature],
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

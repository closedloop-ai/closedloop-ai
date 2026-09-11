import { Priority } from "@repo/api/src/types/common";
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
import { fn } from "storybook/test";
import { ArtifactRowView } from "./artifact-row-view";

/**
 * One row in a list of linked artifacts: a type icon, a short slug, a status
 * icon with a tooltip, the title as a link, and, on the right, an assignee,
 * a priority icon, and a menu for viewing or detaching the link. Use it for
 * a flat or nested list of related documents and issues; a row can indent
 * itself with a small corner arrow to show it's nested under another one.
 * The whole row links through to the artifact when you supply one; without a
 * link, the title renders as plain text and the 'view' menu item is disabled
 * rather than hidden.
 */
const meta = {
  title: "Composites/Documents/Artifact Row View",
  component: ArtifactRowView,
  tags: ["autodocs"],
  argTypes: {
    title: { control: "text", table: { category: "Content" } },
    slug: { control: "text", table: { category: "Content" } },
    typeLabel: { control: "text", table: { category: "Content" } },
    statusLabel: {
      control: "text",
      description:
        "Accessible name for the status button and the copy inside its tooltip.",
      table: { category: "Content" },
    },
    href: {
      control: "text",
      description:
        "Null renders the title as plain text and disables the View item in the overflow menu.",
      table: { category: "Content" },
    },
    typeIcon: { control: false, table: { category: "Appearance" } },
    statusIcon: { control: false, table: { category: "Appearance" } },
    assignee: { control: false, table: { category: "Appearance" } },
    priority: {
      control: { type: "radio" },
      options: Object.values(Priority),
      table: { category: "Appearance" },
    },
    depth: {
      control: { type: "number", min: 1, max: 5, step: 1 },
      description: "Anything past 1 draws the child indent glyph.",
      table: { category: "Appearance" },
    },
    className: { control: false, table: { category: "Appearance" } },
    onDetach: { control: false, table: { category: "Events" } },
  },
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
    onDetach: fn(),
    priority: Priority.High,
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

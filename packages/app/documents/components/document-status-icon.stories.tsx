import {
  DOCUMENT_STATUS_OPTIONS,
  type DocumentStatus,
} from "@repo/api/src/types/document";
import { DOCUMENT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import type { Meta, StoryObj } from "@storybook/react";
import { DocumentStatusIcon } from "./document-status-icon";

// One glyph per Document lifecycle status (PRD/Implementation Plan/Template).
// Documents progress through a filling ring, terminating in a filled ✕ for
// Obsolete. Features use the separate `IssueStatusIcon`.
/**
 * A compact icon marking a document's place in its authoring lifecycle, used
 * instead of a text label wherever documents are listed, distinct from the
 * Issue Status Icon.
 */
const meta = {
  title: "Composites/Documents/Document Status Icon",
  component: DocumentStatusIcon,
  tags: ["autodocs"],
  argTypes: {
    status: { control: "select", options: DOCUMENT_STATUS_OPTIONS },
    size: { control: "select", options: [16, 20] },
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof DocumentStatusIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { status: DOCUMENT_STATUS_OPTIONS[0] },
};

/** Every Document status at the default size. */
export const AllStatuses: Story = {
  args: { status: DOCUMENT_STATUS_OPTIONS[0] },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {DOCUMENT_STATUS_OPTIONS.map((status) => (
        <div
          key={status}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <DocumentStatusIcon status={status as DocumentStatus} />
          <span style={{ fontSize: 11 }}>
            {DOCUMENT_STATUS_LABELS[status as DocumentStatus]}
          </span>
        </div>
      ))}
    </div>
  ),
};

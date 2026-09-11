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
 * A small icon showing where a document, like a PRD, plan, or template, is
 * in its authoring lifecycle: an empty ring for Draft, a half-filled ring
 * for In Review, a full ring for Approved, and a filled circle with a check,
 * an exclamation mark, or an X for Executed, Changes Requested, or Obsolete.
 * Use it anywhere you list documents and need a compact status indicator
 * instead of a text label. Issues follow a different lifecycle and use the
 * separate Issue Status Icon instead, since the two sets of states don't
 * overlap.
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

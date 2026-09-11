import {
  ISSUE_STATUS_OPTIONS,
  type IssueStatus,
} from "@repo/api/src/types/document";
import { ISSUE_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import type { Meta, StoryObj } from "@storybook/react";
import { IssueStatusIcon } from "./issue-status-icon";

// One glyph per Issue delivery-lifecycle status. Issues follow a delivery
// lifecycle (triage → backlog → todo → in progress → in review → done) distinct
// from the Document authoring lifecycle. Documents use `DocumentStatusIcon`.
/**
 * A small icon showing where an issue sits in its delivery lifecycle, from a
 * dashed ring for Backlog through partially filled rings for In Progress and
 * In Review, to a filled circle with a check, an exclamation mark, or an X
 * for Done, Blocked, or Canceled. Triage gets its own icon too: a filled
 * circle with a swap glyph, marking an issue that was triaged automatically
 * rather than by a person. Use it anywhere you list issues and need a
 * compact status indicator; documents follow a different lifecycle and use
 * the separate Document Status Icon instead.
 */
const meta = {
  title: "Composites/Documents/Issue Status Icon",
  component: IssueStatusIcon,
  tags: ["autodocs"],
  argTypes: {
    status: { control: "select", options: ISSUE_STATUS_OPTIONS },
    size: { control: "select", options: [16, 20] },
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof IssueStatusIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { status: ISSUE_STATUS_OPTIONS[0] },
};

/** Every Issue status at the default size. */
export const AllStatuses: Story = {
  args: { status: ISSUE_STATUS_OPTIONS[0] },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {ISSUE_STATUS_OPTIONS.map((status) => (
        <div
          key={status}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <IssueStatusIcon status={status as IssueStatus} />
          <span style={{ fontSize: 11 }}>
            {ISSUE_STATUS_LABELS[status as IssueStatus]}
          </span>
        </div>
      ))}
    </div>
  ),
};

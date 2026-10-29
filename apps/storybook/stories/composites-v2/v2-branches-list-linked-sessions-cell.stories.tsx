import { BRANCHES_LINKED_SESSION_CHIPS_FLAG_KEY } from "@repo/api/src/types/branches-linked-session-chips-flag";
import {
  PROVENANCE_RELATIONSHIP_KIND_LABELS,
  ProvenanceRelationshipKind,
} from "@repo/api/src/types/provenance-relationship";
import { DISPLAYED_SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { BranchRowSession } from "@repo/app/branches/lib/branch-row";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { BranchCellExamples, branchCellRow } from "./v2-branches-list-cells";

// The Branches list's Linked sessions cell: the sessions that wrote to the
// branch. Shipped, it is a count that opens the branch's Sessions tab; behind
// the linked-session chips flag (ISS-8972) it names each session as a chip
// that opens it. When the branch's canonical session count is higher than the
// sessions the row describes, the remainder is an overflow count. No linked
// session shows the empty value.
// The finished list is Surfaces/Artifacts/Branches/Branches List.

const HOUR_MS = 60 * 60 * 1000;
const ONE_CHIP_NAME = /SES-9100/;
const CAPPED_OVERFLOW = /^\+[345]$/;
const NOW_MS = Date.now();

function session(
  suffix: string,
  ownerName: string,
  status: BranchRowSession["status"],
  hoursAgo: number
): BranchRowSession {
  return {
    id: `session-${suffix}`,
    navigableRef: `SES-${suffix}`,
    occurredAt: new Date(NOW_MS - hoursAgo * HOUR_MS).toISOString(),
    ownerName,
    relationshipLabel:
      PROVENANCE_RELATIONSHIP_KIND_LABELS[
        ProvenanceRelationshipKind.Contribution
      ],
    slug: `SES-${suffix}`,
    status,
  };
}

const ONE = [session("9100", "Riley Demo", DISPLAYED_SESSION_STATUS.ACTIVE, 1)];
const TWO = [
  session("9101", "Avery Example", DISPLAYED_SESSION_STATUS.ACTIVE, 3),
  session("9102", "Morgan Sample", DISPLAYED_SESSION_STATUS.INACTIVE, 26),
];

const EXAMPLES = [
  {
    state: "One session",
    row: branchCellRow("sessions-one", { sessionCount: 1, sessions: ONE }),
  },
  {
    state: "Several sessions",
    row: branchCellRow("sessions-several", { sessionCount: 2, sessions: TWO }),
  },
  {
    state: "Count above the sessions described",
    row: branchCellRow("sessions-capped", { sessionCount: 5, sessions: TWO }),
  },
  {
    state: "No linked session",
    row: branchCellRow("sessions-none", { sessionCount: 0, sessions: [] }),
  },
];

const meta = {
  title: "Composites/Artifacts/Branches/Branches List/Linked Sessions Cell",
  tags: ["stable"],
  render: () => (
    <BranchCellExamples
      chipsSupportedBySurface
      columnId="sessions"
      examples={EXAMPLES}
    />
  ),
  parameters: { layout: "padded", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** As shipped: a count that opens the branch's Sessions tab. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("branch-cell-header")).toHaveTextContent(
      "Linked sessions"
    );
    await expect(
      within(canvas.getByTestId("branch-cell-sessions-capped")).getByRole(
        "link"
      )
    ).toHaveAttribute(
      "href",
      "/org-test/branches/sessions-capped?tab=sessions-timeline"
    );
    await expect(
      within(canvas.getByTestId("branch-cell-sessions-none")).queryByRole(
        "link"
      )
    ).toBeNull();
  },
};

/** Behind the linked-session chips flag: one chip per session. */
export const SessionChips: Story = {
  parameters: {
    appCore: { enabledFlags: [BRANCHES_LINKED_SESSION_CHIPS_FLAG_KEY] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await within(canvas.getByTestId("branch-cell-sessions-one")).findByRole(
        "link",
        { name: ONE_CHIP_NAME }
      )
    ).toHaveAttribute("href", "/org-test/sessions/SES-9100");
    // Five linked, two described: the pill counts every linked session with
    // no visible chip, so at least the three the row does not describe. In
    // this 140px track one chip fits (+4); under jsdom every width is 0, so
    // both chips fold into the pill (+5).
    await expect(
      within(canvas.getByTestId("branch-cell-sessions-capped")).getByText(
        CAPPED_OVERFLOW
      )
    ).toBeInTheDocument();
  },
};

export const Dark: Story = { globals: { theme: "dark" } };

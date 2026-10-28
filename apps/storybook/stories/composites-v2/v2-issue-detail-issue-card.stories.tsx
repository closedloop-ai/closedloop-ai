import {
  ISSUE_DESIGN_ARTIFACT,
  ISSUE_DESIGN_BODY,
  ISSUE_DESIGN_PARENT,
  ISSUE_DESIGN_SCENARIOS,
  ISSUE_DESIGN_TEXT_COMMENT,
  IssueDesignState,
  issueCommentHighlights,
} from "@repo/app/issues/components/detail-design/issue-detail-design-fixtures";
import { IssueCard } from "@repo/app/issues/components/issue-card/issue-card";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";

// The Issue Detail page's issue card (ISS-12576, DI-07): the issue's text,
// first on the issue canvas, under the canvas toolbar and above the
// Sub-issues, Branch and Activity summary sections (Ottilie, 2026-10-21).
// "Sub-issue of …" above the title, then the body as markdown. No slug and no
// toolbar (both are on the canvas toolbar), no edited marker and no version:
// issues have no versions, and history is on the Activity tab. A passage an
// open text-anchored comment quotes is highlighted.
// The finished page is Surfaces/Labs/Issues/Issue Detail.
//
// Controls table:
// | Prop | Control | Why |
// |---|---|---|
// No-control table:
// | Prop | Reason |
// |---|---|
// | body, title | the page's fixture issue |
// | highlights, parent, sync | each story picks its own |
//
// No controls: every prop is the fixture issue or a per-story state.

const meta = {
  title: "Composites/Labs/Issues/Issue Detail/Issue Card",
  component: IssueCard,
  tags: ["preview"],
  parameters: { controls: { disable: true } },
  args: {
    body: ISSUE_DESIGN_BODY,
    parent: null,
    sync: null,
    title: ISSUE_DESIGN_ARTIFACT.title,
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl p-5">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof IssueCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The issue's title and body. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", {
        level: 2,
        name: ISSUE_DESIGN_ARTIFACT.title,
      })
    ).toBeVisible();
  },
};

/** A text-anchored comment: the passage it quotes is highlighted. */
export const WithTextComment: Story = {
  args: { highlights: issueCommentHighlights([ISSUE_DESIGN_TEXT_COMMENT]) },
  play: async ({ canvasElement }) => {
    const mark = canvasElement.querySelector("mark");
    await expect(mark?.textContent).toBe(
      issueCommentHighlights([ISSUE_DESIGN_TEXT_COMMENT])[0]
    );
  },
};

/** A sub-issue: its parent above the title. */
export const SubIssue: Story = {
  args: { parent: ISSUE_DESIGN_PARENT },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Sub-issue of", { exact: false })
    ).toBeVisible();
  },
};

/** Came from GitHub. */
export const ImportedFromGitHub: Story = {
  name: "Imported From GitHub",
  args: {
    sync: ISSUE_DESIGN_SCENARIOS[IssueDesignState.ImportedFromGitHub].sync,
  },
};

/** Came from Linear. */
export const ImportedFromLinear: Story = {
  args: {
    sync: ISSUE_DESIGN_SCENARIOS[IssueDesignState.ImportedFromLinear].sync,
  },
};

export const Dark: Story = { globals: { theme: "dark" } };

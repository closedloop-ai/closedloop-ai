import { ACTIVITY_QUERY_DATA } from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import {
  ISSUE_DESIGN_TEXT_COMMENT,
  IssueDesignState,
  issueCommentHighlights,
} from "@repo/app/issues/components/detail-design/issue-detail-design-fixtures";
import { ISSUE_EDIT_BAR_LABEL } from "@repo/app/issues/components/detail-design/issue-detail-design-preview";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { IssueArtifactTabDemo } from "./v2-issue-detail-tabs";

// The Issue Detail page's Artifact Tab body (PRD-751, ISS-12576), as Ottilie
// and Nerys settled it on 2026-10-21: the canvas toolbar (the issue's slug
// and key fields, DI-08; the toolbar the Document page has too) stays at the
// top of the canvas while the issue scrolls under it, with the text controls
// in an edit bar under it once the issue's text is clicked; then the issue's text (DI-07),
// Sub-issues, Branch (DI-10) and Activity summary (DI-09), each under its
// own heading. The toolbar is on this tab only. The state stories are the
// Surfaces page's states that change the canvas.
// The finished page is Surfaces/Labs/Issues/Issue Detail.
//
// Controls are disabled: the body reads the page's fixture issue.

const SECTION_HEADINGS = ["Sub-issues", "Branch", "Activity summary"];

const meta = {
  title: "Composites/Labs/Issues/Issue Detail/Artifact Tab",
  tags: ["preview"],
  render: () => <IssueArtifactTabDemo />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { queryData: ACTIVITY_QUERY_DATA },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Done: the toolbar, then the issue's text and its three sections in order. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("region", { name: "Issue toolbar" })
    ).toBeVisible();
    await expect(
      canvas.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
    ).toEqual(SECTION_HEADINGS);
  },
};

/** Editing the issue's text: the edit bar under the toolbar. */
export const Editing: Story = {
  render: () => <IssueArtifactTabDemo editing />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("toolbar", { name: ISSUE_EDIT_BAR_LABEL })
    ).toBeVisible();
  },
};

/** A comment on a passage: the body highlights the quoted text. */
export const TextComment: Story = {
  render: () => <IssueArtifactTabDemo state={IssueDesignState.TextComment} />,
  play: async ({ canvasElement }) => {
    const mark = canvasElement.querySelector("mark");
    await expect(mark?.textContent).toBe(
      issueCommentHighlights([ISSUE_DESIGN_TEXT_COMMENT])[0]
    );
  },
};

/** Picked up, nothing pushed yet: the Branch section says so. */
export const InProgressNoBranch: Story = {
  render: () => (
    <IssueArtifactTabDemo state={IssueDesignState.InProgressNoBranch} />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("No branch yet")
    ).toBeVisible();
  },
};

/** Future state: an "Other links" section of plain-text URLs (prototype, Storybook). */
export const FutureOtherLinks: Story = {
  render: () => (
    <IssueArtifactTabDemo state={IssueDesignState.FutureOtherLinks} />
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Future state")).toBeVisible();
  },
};

export const Dark: Story = { globals: { theme: "dark" } };

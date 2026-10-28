import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import {
  ISSUE_DESIGN_ARTIFACT,
  ISSUE_DESIGN_SCENARIOS,
  IssueDesignState,
} from "@repo/app/issues/components/detail-design/issue-detail-design-fixtures";
import {
  ISSUE_EDIT_BAR_LABEL,
  IssueDesignToolbar,
} from "@repo/app/issues/components/detail-design/issue-detail-design-preview";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";

// The Issue Detail page's canvas toolbar (ISS-12576 DI-07, ISS-12578 DI-08),
// as Ottilie and Nerys settled it on 2026-10-21, and the same toolbar the
// Document page has (Nerys, 2026-10-22): the document editor's toolbar row at
// the top of the issue canvas, staying there while the issue scrolls under
// it, on the Artifact tab only. The status strip (the issue's slug with the
// issue icon, then its key fields) on the left; the right end is kept for
// Publish. Add comment is in the page header, beside the comments toggle.
// While the issue's text is being edited (a click on it starts editing, as
// in the live document editor), the editor's text controls show in an edit
// bar under it.
// Decision pending: the person field keeps its current label until DI-03
// ruling 1 (ISS-12572).
// The finished page is Surfaces/Labs/Issues/Issue Detail.
//
// Controls are disabled: each story is one state of the toolbar.

function ToolbarDemo({
  editing = false,
  state = IssueDesignState.Default,
}: {
  editing?: boolean;
  state?: IssueDesignState;
}) {
  return (
    <TooltipProvider>
      {/* The canvas card's padding: the toolbar sits flush with its edges. */}
      <div className="m-4 overflow-hidden rounded-lg border bg-card px-5 pt-4">
        <IssueDesignToolbar
          editing={editing}
          scenario={ISSUE_DESIGN_SCENARIOS[state]}
        />
      </div>
    </TooltipProvider>
  );
}

const meta = {
  title: "Composites/Labs/Issues/Issue Detail/Toolbar",
  tags: ["preview"],
  render: () => <ToolbarDemo />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { enabledFlags: [ARTIFACT_PRIORITY_UNSET_FLAG_KEY] },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** A finished issue: its slug and key fields. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toolbar = canvas.getByRole("region", { name: "Issue toolbar" });
    await expect(toolbar).toHaveClass("sticky");
    await expect(canvas.getByText(ISSUE_DESIGN_ARTIFACT.slug)).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Add comment" })
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole("toolbar", { name: ISSUE_EDIT_BAR_LABEL })
    ).not.toBeInTheDocument();
  },
};

/** Just filed: Triage, no owner. */
export const New: Story = {
  render: () => <ToolbarDemo state={IssueDesignState.New} />,
};

/** Editing the issue's text: the edit bar under the toolbar. */
export const Editing: Story = {
  render: () => <ToolbarDemo editing />,
  play: async ({ canvasElement }) => {
    const editBar = within(canvasElement).getByRole("toolbar", {
      name: ISSUE_EDIT_BAR_LABEL,
    });
    await expect(
      within(editBar).getByRole("button", { name: "Bold" })
    ).toBeEnabled();
  },
};

export const Dark: Story = { globals: { theme: "dark" } };

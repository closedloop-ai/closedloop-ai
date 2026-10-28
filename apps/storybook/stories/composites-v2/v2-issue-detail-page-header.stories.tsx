import { AddCommentButton } from "@repo/app/documents/components/detail-design/artifact-canvas-toolbar";
import { ISSUE_DESIGN_ARTIFACT } from "@repo/app/issues/components/detail-design/issue-detail-design-fixtures";
import { ArtifactCommentsToggle } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-toggle";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { IssueDetailPageHeader } from "./v2-artifact-detail-page-header";

// The Issue Detail page's header row (PRD-751, ISS-12586): the route header
// with the Issues breadcrumb, the issue's slug and title, and the
// comments toggle at its end on the tabs the comments rail sits beside
// (Artifact and Sessions, as on Branch Detail), with Add comment just before
// it on the Artifact tab (Nerys, 2026-10-22). It holds nothing issue-only,
// so it matches every artifact's header: the issue's key fields and Add
// comment are in the canvas toolbar (Ottilie, 2026-10-21). The finished page
// is Surfaces/Labs/Issues/Issue Detail.
//
// Controls are disabled: each story is one state of the row.

const COMMENTS_TOGGLE_RE = /comments rail$/;
const PAGE_TITLE = `${ISSUE_DESIGN_ARTIFACT.slug} ${ISSUE_DESIGN_ARTIFACT.title}`;

function PageHeaderDemo({
  withAddComment = false,
  withToggle,
}: {
  withAddComment?: boolean;
  withToggle: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <TooltipProvider>
      <SidebarProvider className="min-h-0">
        <div className="w-full">
          <IssueDetailPageHeader
            addComment={
              withAddComment ? (
                <AddCommentButton onAddComment={() => undefined} />
              ) : null
            }
            commentsToggle={
              withToggle ? (
                <ArtifactCommentsToggle
                  onToggle={() => setOpen((current) => !current)}
                  open={open}
                />
              ) : null
            }
            slug={ISSUE_DESIGN_ARTIFACT.slug}
            title={ISSUE_DESIGN_ARTIFACT.title}
          />
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}

const meta = {
  title: "Composites/Labs/Issues/Issue Detail/Page Header",
  tags: ["preview"],
  render: () => <PageHeaderDemo withAddComment withToggle />,
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/**
 * On Artifact: Add comment, then the comments toggle at the end of the row
 * (Nerys, 2026-10-22).
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const addComment = canvas.getByRole("button", { name: "Add comment" });
    await expect(
      addComment.compareDocumentPosition(
        canvas.getByRole("button", { name: COMMENTS_TOGGLE_RE })
      )
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await expect(
      canvas.getByRole("heading", { level: 1, name: PAGE_TITLE })
    ).toBeInTheDocument();
    const toggle = canvas.getByRole("button", { name: COMMENTS_TOGGLE_RE });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  },
};

/** On Sessions: the comments toggle, and no Add comment. */
export const SessionsTab: Story = {
  render: () => <PageHeaderDemo withToggle />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: COMMENTS_TOGGLE_RE })
    ).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Add comment" })
    ).toBeNull();
  },
};

/** On Details and Activity: no comments rail, so no toggle. */
export const WithoutCommentsToggle: Story = {
  render: () => <PageHeaderDemo withToggle={false} />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByRole("button", { name: COMMENTS_TOGGLE_RE })
    ).toBeNull();
  },
};

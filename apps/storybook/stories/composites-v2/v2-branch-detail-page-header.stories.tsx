import { BRANCH_DESIGN_BASE_DETAIL } from "@repo/app/branches/components/detail-design/branch-detail-design-fixtures";
import { ArtifactCommentsToggle } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-toggle";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { BranchDetailPageHeader } from "./v2-artifact-detail-page-header";

// The Branch Detail page's header row (PRD-751): the route header with the
// Branches breadcrumb and the comments toggle at its end on the tabs the
// comments rail sits beside (Artifact and Sessions). The finished page is
// Surfaces/Artifacts/Branches/Branch Detail; the empty layout is
// Patterns/Artifacts/Branches/Branch Detail.
//
// Controls are disabled: each story is one state of the row.

const COMMENTS_TOGGLE_RE = /comments rail$/;

function PageHeaderDemo({ withToggle }: { withToggle: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <TooltipProvider>
      <SidebarProvider className="min-h-0">
        <div className="w-full">
          <BranchDetailPageHeader
            commentsToggle={
              withToggle ? (
                <ArtifactCommentsToggle
                  onToggle={() => setOpen((current) => !current)}
                  open={open}
                />
              ) : null
            }
            title={BRANCH_DESIGN_BASE_DETAIL.branchName}
          />
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}

const meta = {
  title: "Composites/Artifacts/Branches/Branch Detail/Page Header",
  tags: ["stable"],
  render: () => <PageHeaderDemo withToggle />,
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** On Artifact and Sessions: the comments toggle sits at the end of the row. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", {
        level: 1,
        name: BRANCH_DESIGN_BASE_DETAIL.branchName,
      })
    ).toBeInTheDocument();
    const toggle = canvas.getByRole("button", { name: COMMENTS_TOGGLE_RE });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
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

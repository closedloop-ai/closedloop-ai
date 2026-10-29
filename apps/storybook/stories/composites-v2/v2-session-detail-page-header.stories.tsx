import { SESSION_DESIGN_ARTIFACT } from "@repo/app/agents/components/detail/detail-design/session-detail-design-fixtures";
import {
  SessionDetailStatus,
  SessionOverflowMenu,
  sessionDesignDisplayedStatus,
} from "@repo/app/agents/components/detail/detail-design/session-detail-design-preview";
import { ArtifactCommentsToggle } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-toggle";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { SessionDetailPageHeader } from "./v2-artifact-detail-page-header";

// The Session Detail page's header row (PRD-751): the route header with the
// Sessions breadcrumb, the session's overflow and status after it, and the
// comments toggle at its end on the tabs the comments rail sits beside
// (Artifact). The finished page is Surfaces/Artifacts/Sessions/Session
// Detail; the empty layout is Patterns/Artifacts/Sessions/Session Detail.
//
// Controls are disabled: each story is one state of the row.

const COMMENTS_TOGGLE_RE = /comments rail$/;

function PageHeaderDemo({ withToggle }: { withToggle: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <TooltipProvider>
      <SidebarProvider className="min-h-0">
        <div className="w-full">
          <SessionDetailPageHeader
            commentsToggle={
              withToggle ? (
                <ArtifactCommentsToggle
                  onToggle={() => setOpen((current) => !current)}
                  open={open}
                />
              ) : null
            }
            overflowMenu={<SessionOverflowMenu />}
            status={
              <SessionDetailStatus
                displayedStatus={sessionDesignDisplayedStatus()}
              />
            }
            title={SESSION_DESIGN_ARTIFACT.title}
          />
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}

const meta = {
  title: "Composites/Artifacts/Sessions/Session Detail/Page Header",
  tags: ["stable"],
  render: () => <PageHeaderDemo withToggle />,
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** On Artifact: the comments toggle sits at the end of the row. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", {
        level: 1,
        name: SESSION_DESIGN_ARTIFACT.title,
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

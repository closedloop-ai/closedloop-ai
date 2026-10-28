import { DOCUMENT_DESIGN_ARTIFACT } from "@repo/app/documents/components/detail-design/document-detail-design-fixtures";
import { DocumentDesignToolbar } from "@repo/app/documents/components/detail-design/document-detail-design-preview";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";

// The Document Detail page's canvas toolbar (PRD-751, ISS-12576): the same
// toolbar the Issue page's canvas opens with (Nerys, 2026-10-22), staying at
// the top of the canvas while the document scrolls under it, on the Artifact
// tab only. The live editor's text controls (`DocumentRichTextToolbar`, as
// the live document editor mounts it) on the left, always on: a document is
// always editable here. The version dropdown on the right, where the live
// editor has it; the toolbar's right end is kept for Publish. No slug (the
// page header names the document) and no Add comment (it is in the page
// header, beside the comments toggle).
// The finished page is Surfaces/Labs/Documents/Document Detail.
//
// Controls are disabled: the toolbar has one state.

function ToolbarDemo() {
  return (
    <TooltipProvider>
      {/* The canvas card's padding: the toolbar sits flush with its edges. */}
      <div className="m-4 overflow-hidden rounded-lg border bg-card px-5 pt-4">
        <DocumentDesignToolbar />
      </div>
    </TooltipProvider>
  );
}

const meta = {
  title: "Composites/Labs/Documents/Document Detail/Toolbar",
  tags: ["preview"],
  render: () => <ToolbarDemo />,
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The text controls and the version dropdown. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toolbar = canvas.getByRole("region", { name: "Document toolbar" });
    await expect(toolbar).toHaveClass("sticky");
    await expect(canvas.getByRole("button", { name: "Bold" })).toBeEnabled();
    await expect(
      canvas.getByRole("button", { name: "Select version" })
    ).toBeVisible();
    await expect(
      canvas.queryByText(DOCUMENT_DESIGN_ARTIFACT.slug)
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: "Add comment" })
    ).not.toBeInTheDocument();
  },
};

export const Dark: Story = { globals: { theme: "dark" } };

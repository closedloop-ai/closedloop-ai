import type { Meta, StoryObj } from "@storybook/react";
import { useRef, useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { BranchCommentsTab } from "./branch-comments-model";
import { BranchCommentsRail } from "./branch-comments-rail";

const RESIZE_CONTROL_NAME = "Resize comments rail";

/** Responsive shell matrix for the inline, right-sheet, and bottom-sheet rails. */
const meta = {
  title: "App Core/Branches/Comments Rail",
  component: BranchCommentsRail,
  parameters: { layout: "fullscreen" },
  args: {
    activeTab: BranchCommentsTab.Details,
    children: null,
    onClose: () => undefined,
    onWidthChange: () => undefined,
    open: true,
    returnFocusRef: { current: null },
    width: 380,
  },
} satisfies Meta<typeof BranchCommentsRail>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WideInlineRail: Story = {
  globals: { viewport: { value: "1512-900" } },
  render: () => <RailStory />,
};

export const WideRailAfterResize: Story = {
  globals: { viewport: { value: "1512-900" } },
  render: () => <RailStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const handle = canvas.getByRole("separator", {
      name: RESIZE_CONTROL_NAME,
    });
    await userEvent.pointer([
      { keys: "[MouseLeft>]", target: handle, coords: { clientX: 500 } },
      { coords: { clientX: 420 } },
      { keys: "[/MouseLeft]" },
    ]);
    await expect(canvas.getByTestId("rail-width")).toHaveTextContent("460px");
  },
};

export const NarrowRightSheet: Story = {
  globals: { viewport: { value: "1000-900" } },
  render: () => <RailStory />,
};

export const NarrowCloseReturnsFocus: Story = {
  globals: { viewport: { value: "1000-900" } },
  render: () => <RailStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const close = page.queryByRole("button", { name: "Close" });
    // Portable-story tests do not emulate the viewport global in matchMedia, so
    // they mount the wide splitter. The real 1000px Storybook viewport mounts
    // the Sheet and exercises the close/focus path below.
    if (!close) {
      await expect(
        canvas.getByRole("separator", { name: RESIZE_CONTROL_NAME })
      ).toBeInTheDocument();
      return;
    }
    await userEvent.click(close);
    await expect(
      canvas.getByRole("button", { name: "Show comments" })
    ).toHaveFocus();
  },
};

export const MobileBottomSheet: Story = {
  globals: { viewport: { value: "360-720" } },
  render: () => <RailStory />,
};

export const Closed: Story = {
  globals: { viewport: { value: "1512-900" } },
  render: () => <RailStory initialOpen={false} />,
};

function RailStory({ initialOpen = true }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [width, setWidth] = useState(380);
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex min-h-[42rem] justify-end bg-background">
      <div className="mr-auto p-4">
        <button
          aria-expanded={open}
          className="text-sm underline"
          onClick={() => setOpen((current) => !current)}
          ref={returnFocusRef}
          type="button"
        >
          {open ? "Hide comments" : "Show comments"}
        </button>
        <p
          className="mt-2 text-muted-foreground text-xs"
          data-testid="rail-width"
        >
          {width}px
        </p>
      </div>
      <BranchCommentsRail
        activeTab={BranchCommentsTab.Details}
        onClose={() => setOpen(false)}
        onWidthChange={setWidth}
        open={open}
        returnFocusRef={returnFocusRef}
        width={width}
      >
        <div className="min-h-64 p-4">
          <h2 className="font-medium text-sm">Comments</h2>
          <p className="mt-2 text-muted-foreground text-xs">
            Selected pull request discussion appears here.
          </p>
        </div>
      </BranchCommentsRail>
    </div>
  );
}

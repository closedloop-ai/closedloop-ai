import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@repo/design-system/components/ui/resizable";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * Splits an area into panels separated by draggable handles, so someone can
 * drag a handle to resize the panels on either side of it. Nest panel groups
 * inside one another, as in the story's second panel, to build split layouts
 * more complex than a single row or column. Give it an autoSaveId to
 * remember the sizes a person dragged to across page reloads, and each
 * handle is keyboard operable: focus it and press an arrow key to resize by
 * a set percentage.
 */
const meta: Meta<typeof ResizablePanelGroup> = {
  title: "Primitives/Layout/Resizable Panel Group",
  component: ResizablePanelGroup,
  tags: ["autodocs"],
  argTypes: {
    direction: {
      control: { type: "radio" },
      options: ["horizontal", "vertical"],
      description: "Axis the top-level panels are laid out along.",
    },
    children: {
      control: false,
      description:
        "The `ResizablePanel` / `ResizableHandle` tree. Supplied by the story render, not by a control.",
    },
    className: {
      control: "text",
      description: "Extra classes merged onto the group container.",
    },
    autoSaveId: {
      control: "text",
      description:
        "Key the layout is persisted under in storage. Leave empty to keep the layout in memory only.",
    },
    keyboardResizeBy: {
      control: { type: "number", min: 1, max: 100, step: 1 },
      description:
        "Percentage a panel moves per arrow key press on a focused handle.",
    },
    storage: {
      control: false,
      description: "Custom storage adapter used with `autoSaveId`.",
    },
    onLayout: {
      control: false,
      table: { category: "Events" },
    },
  },
  args: {
    className: "max-w-96 rounded-lg border",
    direction: "horizontal",
    onLayout: fn(),
  },
  render: (args) => (
    <ResizablePanelGroup {...args}>
      <ResizablePanel defaultSize={50}>
        <div className="flex h-[200px] items-center justify-center p-6">
          <span className="font-semibold">One</span>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={50}>
        <ResizablePanelGroup direction="vertical">
          <ResizablePanel defaultSize={25}>
            <div className="flex h-full items-center justify-center p-6">
              <span className="font-semibold">Two</span>
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={75}>
            <div className="flex h-full items-center justify-center p-6">
              <span className="font-semibold">Three</span>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  ),
} satisfies Meta<typeof ResizablePanelGroup>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the resizable panel group.
 */
export const Default: Story = {};

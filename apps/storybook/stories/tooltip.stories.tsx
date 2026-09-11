import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import type { Meta, StoryObj } from "@storybook/react";
import { Plus } from "lucide-react";
import { fn } from "storybook/test";

/**
 * A small hover or focus hint of a word or two, good for explaining an
 * icon-only button, and reach for the Popover instead once the content needs
 * more than a line of text.
 */
const meta: Meta<typeof TooltipContent> = {
  title: "Primitives/Overlays/Tooltip",
  component: TooltipContent,
  tags: ["autodocs"],
  argTypes: {
    side: {
      options: ["top", "bottom", "left", "right"],
      control: {
        type: "radio",
      },
      table: { category: "Position" },
    },
    sideOffset: {
      control: { type: "number", min: 0, max: 24, step: 1 },
      table: { category: "Position" },
      description: "Distance in pixels between the tooltip and its trigger.",
    },
    align: {
      options: ["start", "center", "end"],
      control: { type: "radio" },
      table: { category: "Position" },
    },
    alignOffset: {
      control: { type: "number", min: -24, max: 24, step: 1 },
      table: { category: "Position" },
    },
    avoidCollisions: {
      control: "boolean",
      table: { category: "Position" },
      description: "Flip the tooltip when it would overflow the viewport.",
    },
    sticky: {
      options: ["partial", "always"],
      control: { type: "radio" },
      table: { category: "Position" },
      description:
        "How hard the tooltip stays with the trigger while it scrolls out of view.",
    },
    hideWhenDetached: {
      control: "boolean",
      table: { category: "Position" },
    },
    arrowPadding: {
      control: { type: "number", min: 0, max: 20, step: 1 },
      table: { category: "Appearance" },
      description: "Keeps the arrow this far from the tooltip's corners.",
    },
    hideArrow: {
      control: "boolean",
      table: { category: "Appearance" },
      description:
        "Hide the pointer for rich or popover-styled tooltip surfaces.",
    },
    children: {
      control: "text",
      table: { category: "Content" },
    },
    asChild: { control: false, table: { category: "Content" } },
    collisionBoundary: { control: false, table: { category: "Position" } },
    onEscapeKeyDown: { control: false, table: { category: "Events" } },
    onPointerDownOutside: { control: false, table: { category: "Events" } },
  },
  args: {
    side: "top",
    sideOffset: 0,
    align: "center",
    alignOffset: 0,
    avoidCollisions: true,
    sticky: "partial",
    hideWhenDetached: false,
    arrowPadding: 0,
    hideArrow: false,
    children: "Add to library",
    onEscapeKeyDown: fn(),
    onPointerDownOutside: fn(),
  },
  parameters: {
    layout: "centered",
  },
  render: (args) => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger>
          <Plus className="h-4 w-4" />
          <span className="sr-only">Add</span>
        </TooltipTrigger>
        <TooltipContent {...args} />
      </Tooltip>
    </TooltipProvider>
  ),
} satisfies Meta<typeof TooltipContent>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the tooltip.
 */
export const Default: Story = {};

const ALL_SIDES = ["top", "bottom", "left", "right"] as const;

/**
 * Every `side` value rendered together, each labelled, with the tooltip
 * forced open via `defaultOpen` so the position is actually visible in a
 * static render. The individual side stories were pure position permutations
 * of the same tooltip, so this one story keeps a single Chromatic snapshot
 * covering all of them instead of one snapshot per side. Drive a single side
 * through the Controls panel on the Default story above.
 */
export const AllSides: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 48, padding: 48 }}>
      {ALL_SIDES.map((side) => (
        <div
          key={side}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
          }}
        >
          <TooltipProvider>
            <Tooltip defaultOpen>
              <TooltipTrigger>
                <Plus className="h-4 w-4" />
                <span className="sr-only">Add</span>
              </TooltipTrigger>
              <TooltipContent avoidCollisions={false} side={side}>
                Add to library
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <span style={{ fontSize: 11 }}>{side}</span>
        </div>
      ))}
    </div>
  ),
};

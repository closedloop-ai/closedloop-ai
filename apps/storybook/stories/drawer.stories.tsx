import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@repo/design-system/components/ui/drawer";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * A panel that slides in from an edge of the screen, usually the bottom, and
 * can be dragged closed by hand the way a native mobile sheet would be.
 * Reach for it over the Sheet or Dialog when the surface should feel touch
 * friendly and draggable, particularly on small screens; the Sheet covers
 * the same side panel role without the drag gesture. It can slide in from
 * any of the four edges, and you can restrict dragging to just its handle,
 * scale the page behind it as it opens, or turn off dismissing it by drag,
 * tap outside or Escape entirely.
 */
const meta: Meta<typeof Drawer> = {
  title: "Primitives/Overlays/Drawer",
  component: Drawer,
  tags: ["autodocs"],
  argTypes: {
    direction: {
      options: ["top", "bottom", "left", "right"],
      control: { type: "radio" },
      table: { category: "Appearance" },
      description: "Edge of the viewport the drawer slides in from.",
    },
    shouldScaleBackground: {
      control: "boolean",
      table: { category: "Appearance" },
      description: "Scales the page behind the drawer while it is open.",
    },
    open: {
      control: false,
      table: { category: "Behavior" },
      description:
        "Controlled open state. Left uncontrolled here so the trigger still works; use defaultOpen to start open.",
    },
    defaultOpen: {
      control: "boolean",
      table: { category: "Behavior" },
    },
    modal: {
      control: "boolean",
      table: { category: "Behavior" },
      description: "Blocks interaction with the page behind the drawer.",
    },
    dismissible: {
      control: "boolean",
      table: { category: "Behavior" },
      description: "Allows closing by drag, scrim click, or Escape.",
    },
    handleOnly: {
      control: "boolean",
      table: { category: "Behavior" },
      description:
        "Limits dragging to the handle instead of the whole content.",
    },
    closeThreshold: {
      control: { type: "number", min: 0, max: 1, step: 0.05 },
      table: { category: "Behavior" },
      description: "Fraction of the drawer that must be dragged away to close.",
    },
    scrollLockTimeout: {
      control: { type: "number", min: 0, max: 1000, step: 50 },
      table: { category: "Behavior" },
      description: "Milliseconds after a scroll before dragging resumes.",
    },
    onOpenChange: { control: false, table: { category: "Events" } },
    onClose: { control: false, table: { category: "Events" } },
    onDrag: { control: false, table: { category: "Events" } },
    onRelease: { control: false, table: { category: "Events" } },
    onAnimationEnd: { control: false, table: { category: "Events" } },
  },
  render: (args) => (
    <Drawer {...args}>
      <DrawerTrigger>Open</DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Are you sure absolutely sure?</DrawerTitle>
          <DrawerDescription>This action cannot be undone.</DrawerDescription>
        </DrawerHeader>
        <DrawerFooter>
          <button
            className="rounded bg-primary px-4 py-2 text-primary-foreground"
            type="button"
          >
            Submit
          </button>
          <DrawerClose>
            <button className="hover:underline" type="button">
              Cancel
            </button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
  parameters: {
    layout: "centered",
  },
  args: {
    direction: "bottom",
    defaultOpen: false,
    modal: true,
    dismissible: true,
    handleOnly: false,
    shouldScaleBackground: false,
    closeThreshold: 0.25,
    scrollLockTimeout: 100,
    onOpenChange: fn(),
    onClose: fn(),
    onDrag: fn(),
    onRelease: fn(),
    onAnimationEnd: fn(),
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the drawer.
 */
export const Default: Story = { args: {} as never };

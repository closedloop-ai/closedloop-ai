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

/**
 * A drawer component for React.
 */
const meta: Meta<typeof Drawer> = {
  title: "Primitives v1.0/Overlays/Drawer",
  component: Drawer,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    // Both props are real `boolean`s (vaul's `Drawer.Root`), but this
    // preview's global `controls.matchers.color` (`.storybook/preview.tsx`)
    // matches any arg NAME ending in "background" or "color" regardless of
    // its actual type, so left un-overridden both got auto-assigned a
    // `color` swatch control — which the addon then rejects outright
    // ("Control of type color only supports string") since the value is a
    // boolean. Pinning the real control type here overrides the matcher.
    shouldScaleBackground: { control: "boolean" },
    setBackgroundColorOnScale: { control: "boolean" },
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
};

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the drawer.
 */
export const Default: Story = { args: {} as never };

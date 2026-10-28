import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import { Loader2, Mail } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { expect, userEvent, within } from "storybook/test";

type ButtonSize = NonNullable<ComponentProps<typeof Button>["size"]>;

/**
 * Every size, and whether it renders a square box with no room alongside an
 * icon. An exhaustive `Record` rather than a `Set` literal on purpose: a set is
 * a side inventory of the union that a new member can be added behind, and the
 * icon-size trap this file exists to close would quietly reopen. Adding a size
 * to `Button` fails `tsc` here until it is classified.
 */
const SIZE_IS_ICON_ONLY: Record<ButtonSize, boolean> = {
  default: false,
  sm: false,
  lg: false,
  icon: true,
  "icon-sm": true,
};

/** The label every story starts with, so a typed-in one can be told apart. */
const DEFAULT_LABEL = "Button";

/**
 * An icon size is a square the width of its height, so the default text label
 * renders as a clipped word in a box: a shape the product never ships. Switch
 * to an icon when an icon size is picked and the label is still the untouched
 * default, and leave a label you typed yourself alone.
 */
function childForSize(
  size: ComponentProps<typeof Button>["size"],
  children: ReactNode
) {
  if (size && SIZE_IS_ICON_ONLY[size] && children === DEFAULT_LABEL) {
    return <Mail />;
  }

  return children;
}

/**
 * Displays a button or a component that looks like a button.
 */
const meta = {
  title: "Primitives v1.0/Actions/Button",
  component: Button,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    children: {
      control: "text",
      description:
        "What the button says. On an icon size the default label becomes an icon instead. A label you type is used as it is.",
    },
    variant: {
      options: [
        "default",
        "destructive",
        "outline",
        "secondary",
        "ghost",
        "link",
        "linkForeground",
      ],
      control: { type: "radio" },
    },
    size: {
      options: ["default", "sm", "lg", "icon", "icon-sm"],
      control: { type: "radio" },
      description:
        "Height, plus a matching width on the two icon sizes. Those are square and hold one icon, with no room for a label, so picking one swaps the label for an icon.",
    },
  },
  parameters: {
    layout: "centered",
  },
  // At the meta level, so every story without its own `render` — Outline,
  // Ghost, Secondary, Destructive, Link, Small, Large — gets the swap too.
  // Declared per-story it covered only the two that declared it, and changing
  // `size` to an icon size on any of the rest kept the clipped label.
  render: ({ children, ...args }) => (
    <Button {...args}>{childForSize(args.size, children)}</Button>
  ),
  args: {
    variant: "default",
    size: "default",
    children: DEFAULT_LABEL,
  },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the button, used for primary actions and commands.
 */
export const Default: Story = {
  render: ({ children, ...args }) => (
    <Button {...args}>{childForSize(args.size, children)}</Button>
  ),
};

/**
 * Use the `outline` button to reduce emphasis on secondary actions, such as
 * canceling or dismissing a dialog.
 */
export const Outline: Story = {
  args: {
    variant: "outline",
  },
};

/**
 * Use the `ghost` button is minimalistic and subtle, for less intrusive
 * actions.
 */
export const Ghost: Story = {
  args: {
    variant: "ghost",
  },
};

/**
 * Use the `secondary` button to call for less emphasized actions, styled to
 * complement the primary button while being less conspicuous.
 */
export const Secondary: Story = {
  args: {
    variant: "secondary",
  },
};

/**
 * Use the `destructive` button to indicate errors, alerts, or the need for
 * immediate attention.
 */
export const Destructive: Story = {
  args: {
    variant: "destructive",
  },
};

/**
 * Use the `link` button to reduce emphasis on tertiary actions, such as
 * hyperlink or navigation, providing a text-only interactive element.
 */
export const Link: Story = {
  args: {
    variant: "link",
  },
};

/**
 * Use the `linkForeground` button for an inline link inside running text that
 * should read as part of the sentence rather than as a brand-colored call to
 * action — the "Sign up" prompt on the Login surface, next to plain body copy.
 * Same affordance as `link`, in the foreground tone.
 */
export const LinkForeground: Story = {
  args: {
    variant: "linkForeground",
  },
};

/**
 * All seven variants rendered together for side-by-side comparison. A human
 * convenience for scanning relative emphasis; excluded from the AI manifest
 * since each variant already has its own single-concept story above.
 */
export const AllVariants: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Button>Default</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="link">Link</Button>
      <Button variant="linkForeground">LinkForeground</Button>
    </div>
  ),
};

/**
 * Shows the focus-visible ring keyboard users see. Tabs into the button and
 * asserts it received focus, so the state is both visible and verified.
 */
export const Focus: Story = {
  args: {
    children: "Focused Button",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // `userEvent.tab()` walks from `document.activeElement`, which is the
    // document's — not this canvas's. `meta` carries `autodocs`, so on the
    // Docs page every story on it shares one document and the first Tab
    // lands on AllVariants' first button, outside `canvasElement`. Seeding
    // focus on the canvas itself puts the next tab stop inside it. The same
    // trick as sidebar.stories.tsx, which has a search field to seed from;
    // this story has only the button under test. `tabIndex = -1` is not a
    // tab stop, so it adds none.
    canvasElement.tabIndex = -1;
    canvasElement.focus();
    await userEvent.tab();
    await expect(canvas.getByRole("button")).toHaveFocus();
  },
};

/**
 * Add `asChild` to render the child element (here, a real anchor) with the
 * button's styling instead of wrapping it in a nested `<button>`. Use this
 * for a button that navigates to another route.
 */
export const AsChild: Story = {
  render: (args) => (
    <Button {...args} asChild>
      <a href="/settings">Navigate as a button</a>
    </Button>
  ),
};

/**
 * Add the `disabled` prop to a button to prevent interactions and add a
 * loading indicator, such as a spinner, to signify an in-progress action.
 */
export const Loading: Story = {
  render: (args) => (
    <Button {...args}>
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      Button
    </Button>
  ),
  args: {
    ...Outline.args,
    disabled: true,
  },
};

/**
 * Add an icon element to a button to enhance visual communication and
 * providing additional context for the action.
 */
export const WithIcon: Story = {
  render: (args) => (
    <Button {...args}>
      <Mail /> Login with Email Button
    </Button>
  ),
  args: {
    ...Secondary.args,
  },
};

/**
 * Use the `sm` size for a smaller button, suitable for interfaces needing
 * compact elements without sacrificing usability.
 */
export const Small: Story = {
  args: {
    size: "sm",
  },
};

/**
 * Use the `lg` size for a larger button, offering better visibility and
 * easier interaction for users.
 */
export const Large: Story = {
  args: {
    size: "lg",
  },
};

/**
 * Use the "icon" size for a button with only an icon.
 */
export const Icon: Story = {
  args: {
    ...Secondary.args,
    size: "icon",
    children: <Mail />,
  },
};

/**
 * Use the `icon-sm` size for a smaller icon-only button, suitable for dense
 * toolbars and compact controls.
 */
export const IconSm: Story = {
  args: {
    ...Secondary.args,
    size: "icon-sm",
    children: <Mail />,
  },
};

/**
 * Add the `disabled` prop to prevent interactions with the button.
 */
export const Disabled: Story = {
  render: ({ children, ...args }) => (
    <Button {...args}>{childForSize(args.size, children)}</Button>
  ),
  args: {
    disabled: true,
  },
};

import type { Decorator, Meta, StoryObj } from "@storybook/react";
import {
  BotIcon,
  HammerIcon,
  LayersIcon,
  PlugIcon,
  TerminalIcon,
  WebhookIcon,
  WrenchIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { fn } from "storybook/test";
import {
  type AgentsTypeTabOption,
  AgentsTypeTabStrip,
} from "./agents-type-tab-strip";

/**
 * ISS-4803: the Agents catalog type strip at the widths it actually has to
 * survive.
 *
 * FEA-4019 grew the strip to eight segments. On a desktop row they all fit and
 * there is nothing to look at; the story worth having is the phone, where the
 * trailing four are clipped by the scroll track and — before this change — had
 * no control that reached them. Every story below pins a real row width, because
 * that constraint IS the design problem: the strip fits itself to its MEASURED
 * row, not to a viewport breakpoint, so a story that does not pin a width is a
 * story about nothing.
 */

const STRIP_OPTIONS: readonly AgentsTypeTabOption[] = [
  { value: "all", label: "All", icon: LayersIcon },
  { value: "agent", label: "Agents", icon: BotIcon },
  { value: "command", label: "Commands", icon: TerminalIcon },
  { value: "skill", label: "Skills", icon: HammerIcon },
  { value: "plugin", label: "Plugins", icon: LayersIcon },
  { value: "mcp", label: "MCPs", icon: PlugIcon },
  { value: "tool", label: "Tools", icon: WrenchIcon },
  { value: "hook", label: "Hooks", icon: WebhookIcon },
];

/** The reported phone viewport from the ticket's evidence screenshots. */
const PHONE_VIEWPORT_PX = 390;

/** A comfortable desktop pane, where the whole strip fits. */
const DESKTOP_VIEWPORT_PX = 1100;

const meta = {
  title: "App Core/Agents/Agents Type Tab Strip",
  component: AgentsTypeTabStrip,
  tags: ["autodocs"],
  argTypes: {
    // Each option carries a `LucideIcon` component; an object control would
    // hand back a plain object and the strip would render a missing icon.
    options: { control: false },
    value: {
      control: "select",
      options: STRIP_OPTIONS.map((option) => option.value),
    },
    overflowMenuEnabled: { control: "boolean" },
    onValueChange: { control: false, table: { category: "Events" } },
  },
  parameters: { layout: "fullscreen" },
  args: {
    onValueChange: fn(),
    options: STRIP_OPTIONS,
    overflowMenuEnabled: true,
    value: "all",
  },
} satisfies Meta<typeof AgentsTypeTabStrip>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * A 390px phone row with the disclosure ON: the strip shows what it can fit and
 * the rest sit behind a counter that names them. The counter is a real button,
 * so it is a tab stop and opens its menu from the keyboard — which the scroll
 * track alone never was, the strip being one roving-tabindex control.
 */
export const PhoneWithOverflow: Story = {
  decorators: [rowAtWidth(PHONE_VIEWPORT_PX)],
};

/**
 * The same row with the flag OFF — what ships today. Every segment is rendered,
 * the ones past the fold are clipped by the scroll track, and the only cue that
 * anything is missing is the edge fade on the right. This is the state the
 * ticket was filed against; keep it beside the story above.
 */
export const PhoneWithoutOverflow: Story = {
  args: { overflowMenuEnabled: false },
  decorators: [rowAtWidth(PHONE_VIEWPORT_PX)],
};

/**
 * A tab that does not fit, selected. The selection is the only thing telling the
 * user what the catalog below is filtered to, so it is pulled into the last
 * visible slot rather than left inside the menu — a strip whose every visible
 * segment reads unselected would say "All", which is not what is on screen.
 */
export const PhoneWithOverflowedTabSelected: Story = {
  args: { value: "hook" },
  decorators: [rowAtWidth(PHONE_VIEWPORT_PX)],
};

/**
 * A desktop pane. The fit is measured, not a breakpoint, so at this width every
 * segment stays on the strip and the counter is not rendered at all — the change
 * costs a wide window nothing.
 */
export const DesktopFullStrip: Story = {
  decorators: [rowAtWidth(DESKTOP_VIEWPORT_PX)],
};

/**
 * Renders the strip inside a box of a fixed width, the way a real surface hands
 * it one. The strip measures its own row, so this box is what the fit reacts to.
 */
function rowAtWidth(widthPx: number): Decorator {
  return (Story) => (
    <div className="bg-background p-4">
      <StripFrame widthPx={widthPx}>
        <Story />
      </StripFrame>
    </div>
  );
}

function StripFrame({
  children,
  widthPx,
}: Readonly<{ children: ReactNode; widthPx: number }>) {
  return (
    <div
      className="overflow-hidden rounded-md border"
      style={{ width: widthPx }}
    >
      {children}
    </div>
  );
}

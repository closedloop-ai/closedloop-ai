import {
  RunActionMenuItem,
  RunInFlightMenuNote,
  RunInFlightReason,
} from "@repo/app/documents/components/run-action-availability";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import type { Meta, StoryObj } from "@storybook/react";
import { GaugeIcon, PlayIcon, SparklesIcon } from "lucide-react";

const REASON_ID = "run-in-flight-reason";

/**
 * The note explaining why a run action like Start Building is greyed out in
 * an artifact's Actions menu, kept reachable by keyboard and screen reader.
 */
const meta = {
  title: "Composites/Documents/Run Action Availability",
  component: RunInFlightReason,
  tags: ["autodocs"],
  argTypes: {
    id: { control: "text" },
    live: { control: "boolean" },
    className: { control: false },
  },
  parameters: {
    layout: "padded",
  },
  args: {
    id: REASON_ID,
    live: false,
  },
} satisfies Meta<typeof RunInFlightReason>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The explanation on its own, as it reads beneath a control. */
export const Reason: Story = {};

/**
 * An artifact header's Actions menu while a run of the `execute` command is in
 * flight. "Start Building" is `aria-disabled` rather than `disabled`, so it
 * keeps its place in the menu's roving focus and its `aria-describedby` reaches
 * the footer line. "Generate Plan" is disabled for an unrelated reason and is
 * deliberately NOT explained.
 */
export const MenuWithRunInFlight: Story = {
  render: () => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button size="sm">Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <RunActionMenuItem
          disabled
          onActivate={() => undefined}
          reasonId={REASON_ID}
          runInFlight={false}
        >
          <SparklesIcon className="h-4 w-4" />
          Generate Plan
        </RunActionMenuItem>
        <RunActionMenuItem
          onActivate={() => undefined}
          reasonId={REASON_ID}
          runInFlight={true}
        >
          <PlayIcon className="h-4 w-4" />
          Start Building
        </RunActionMenuItem>
        <RunActionMenuItem
          onActivate={() => undefined}
          reasonId={REASON_ID}
          runInFlight={false}
        >
          <GaugeIcon className="h-4 w-4" />
          Evaluate Issue
        </RunActionMenuItem>
        <DropdownMenuSeparator />
        <RunInFlightMenuNote id={REASON_ID} />
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/** The same menu with nothing running — no explanation exists at all. */
export const MenuWithNothingRunning: Story = {
  render: () => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button size="sm">Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <RunActionMenuItem
          onActivate={() => undefined}
          reasonId={REASON_ID}
          runInFlight={false}
        >
          <SparklesIcon className="h-4 w-4" />
          Generate Plan
        </RunActionMenuItem>
        <RunActionMenuItem
          onActivate={() => undefined}
          reasonId={REASON_ID}
          runInFlight={false}
        >
          <PlayIcon className="h-4 w-4" />
          Start Building
        </RunActionMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

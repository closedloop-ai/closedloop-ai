import {
  SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID,
  SESSION_LINKED_PROJECTS_OVERFLOW_TEST_ID,
  type SessionLinkedEntityChip,
} from "@repo/app/agents/lib/session-linked-entity-chips";
import type { Meta, StoryObj } from "@storybook/react";
import { FolderIcon, TicketIcon } from "lucide-react";
import { SessionLinkedChipsCell } from "./session-linked-chips-cell";

// FEA-4209 / FEA-4210: the shared linked-entity cell, isolated.
// The Sessions grid renders this inside a measured track, so the states that
// matter are not "one chip" versus "many" — they are what the cell does when the
// track cannot hold what the row has to say, and what it does when the surface
// could not resolve a destination. Both are here, because both are the cases the
// grid itself makes hard to see.
/**
 * This is the shared cell used for both the "Owning project" and "Linked
 * issues" columns in the Sessions table, rendering one or more small linked
 * pills with a leading icon. When there are more chips than the column can
 * fit, the extra ones collapse behind a "+N" button that opens a popover
 * listing them, reachable by keyboard and touch, not only by hovering. A
 * chip whose destination could not be resolved still shows its label; it
 * just is not clickable. In the narrower card layout below the table's
 * breakpoint, the cell instead shows every chip and wraps, rather than
 * hiding any behind the overflow button.
 */
const meta: Meta<typeof SessionLinkedChipsCell> = {
  component: SessionLinkedChipsCell,
  title: "Composites/Sessions/Listing/Session Linked Chips Cell",
  tags: ["autodocs"],
  argTypes: {
    chips: { control: "object" },
    icon: {
      control: false,
      description:
        "Leading glyph shared by every chip in the column. A rendered element, so it is set per story.",
    },
    overflowNoun: {
      control: "text",
      description:
        "Singular noun the +N counter announces, so a screen reader hears what is hidden.",
    },
    testId: { control: "text" },
    uncapped: {
      control: "boolean",
      description:
        "Render every chip instead of collapsing into +N. The card fallback below the grid breakpoint.",
    },
  },
  args: { uncapped: false },
};

export default meta;

type Story = StoryObj<typeof SessionLinkedChipsCell>;

function issueChip(
  slug: string,
  title: string | null = null
): SessionLinkedEntityChip {
  return { key: slug, label: slug, href: `/acme/issues/${slug}`, title };
}

const TICKET_ICON = <TicketIcon aria-hidden />;
const FOLDER_ICON = <FolderIcon aria-hidden />;

/** The ordinary row: a couple of issues, each a real link. */
export const LinkedIssues: Story = {
  args: {
    chips: [
      issueChip("FEA-4209", "Project(s) column on the Sessions table"),
      issueChip("FEA-4210"),
    ],
    icon: TICKET_ICON,
    overflowNoun: "issue",
    testId: SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID,
  },
};

/**
 * The crowded row. The `+N` counter is a real button — keyboard and touch reach
 * it — and its accessible name lists what it is hiding, so `+6` is never the
 * whole story a screen reader gets.
 */
export const OverflowingIssues: Story = {
  args: {
    ...LinkedIssues.args,
    chips: Array.from({ length: 8 }, (_unused, index) =>
      issueChip(`FEA-${4200 + index}`)
    ),
  },
};

/**
 * The card fallback below the breakpoint: a card field is a full-width line that
 * can wrap, and it is a touch surface, so nothing collapses behind an affordance
 * a phone has to hunt for.
 */
export const UncappedForCardFallback: Story = {
  args: { ...OverflowingIssues.args, uncapped: true },
};

/**
 * A session's project. Inert by design: the project detail route needs a team id
 * the session list contract does not carry, so the chip names the project rather
 * than guessing a destination.
 */
export const Projects: Story = {
  args: {
    chips: [
      { key: "project-1", label: "Platform Core", href: null, title: null },
    ],
    icon: FOLDER_ICON,
    overflowNoun: "project",
    testId: SESSION_LINKED_PROJECTS_OVERFLOW_TEST_ID,
  },
};

/**
 * What an unresolvable destination looks like. Not a dead link and not a hidden
 * row — the chip still states which issue this is, it just does not pretend to
 * be clickable.
 */
export const UnresolvableDestination: Story = {
  args: {
    ...LinkedIssues.args,
    chips: [{ key: "artifact-1", label: "FEA-654", href: null, title: null }],
  },
};

import {
  ActivityCardLayout,
  ActivityCommentCard,
} from "@repo/app/documents/components/feed-sidebar/sources/activity-card";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import {
  ACTIVITY_FIXTURE_NOW,
  ACTIVITY_QUERY_DATA,
  COMMENT_LONG,
  COMMENT_SHORT,
  COMMENT_UNAVAILABLE,
} from "./activity-catalog.fixtures";
import {
  type ActivityTimelineRow,
  ActivityTimelineRowKind,
} from "./activity-timeline";

/**
 * A comment on the Activity tab (ISS-12117, catalog row CM): a read-only box
 * with the author's avatar on the timeline's line, "Name commented · time",
 * the body clamped to three lines and "View comment →" pointing at where the
 * comment really lives. The tab is an audit trail, so the only action is Copy
 * link — no reply, reaction or edit.
 *
 * Comments are not activity events (ISS-10994): Documents supply them from
 * Liveblocks; Session and Branch hosts supply their own. Story docs only.
 *
 * Controls table:
 * | Prop | Control | Why |
 * |---|---|---|
 * | body | text | the comment text; long text clamps to three lines |
 * | unavailable | boolean | the comment was deleted or cannot be read |
 * No-control table:
 * | Prop | Reason |
 * |---|---|
 * | authorId, createdAt, href | fixture comment; the author resolves through the seeded directory |
 * | layout | fixed to the timeline look; the rail look is the v1.0 Activity Card View story |
 * | now | pinned to the fixtures' clock so relative times are deterministic |
 */
const meta = {
  title: "Composites/Shared/Activity/Activity Comment Card",
  component: ActivityCommentCard,
  tags: ["stable", "autodocs"],
  parameters: {
    layout: "padded",
    appCore: { queryData: ACTIVITY_QUERY_DATA },
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    body: { control: "text" },
    unavailable: { control: "boolean" },
    authorId: { control: false },
    createdAt: { control: false },
    href: { control: false },
    layout: { control: false },
    now: { control: false },
  },
  args: {
    ...commentArgs(COMMENT_SHORT),
    layout: ActivityCardLayout.Timeline,
    now: ACTIVITY_FIXTURE_NOW,
  },
} satisfies Meta<typeof ActivityCommentCard>;

export default meta;
type Story = StoryObj<typeof meta>;

function commentArgs(row: ActivityTimelineRow) {
  if (row.kind !== ActivityTimelineRowKind.Comment) {
    throw new Error("Activity Comment Card stories render comment rows only");
  }
  return {
    authorId: row.authorId,
    createdAt: row.createdAt,
    href: row.href,
    body: row.body,
    unavailable: row.unavailable ?? false,
  };
}

/** A short comment, the link out, and the one menu action. */
export const Short: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Jake Morrison")).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: "View comment" })
    ).toHaveAttribute("href", "#comment-cm-short");
    await userEvent.click(canvas.getByRole("button", { name: "More actions" }));
    const menu = within(canvasElement.ownerDocument.body);
    await expect(menu.getAllByRole("menuitem")).toHaveLength(1);
    await expect(menu.getByRole("menuitem")).toHaveTextContent("Copy link");
    await userEvent.keyboard("{Escape}");
  },
};

/** A deleted or unreadable comment: said plainly, with nothing to open. */
export const Unavailable: Story = {
  args: commentArgs(COMMENT_UNAVAILABLE),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("This comment is no longer available.")
    ).toBeVisible();
    await expect(
      canvas.queryByRole("link", { name: "View comment" })
    ).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: "More actions" })
    ).toBeNull();
  },
};

/** A long comment, clamped to three lines; the link opens the rest. */
export const Long: Story = {
  args: commentArgs(COMMENT_LONG),
};

/** The comment box in the dark theme. */
export const Dark: Story = {
  args: commentArgs(COMMENT_LONG),
  globals: { theme: "dark" },
};

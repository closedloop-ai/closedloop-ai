import {
  ThreadStatus,
  TraceCommentKind,
  TraceCommentSurface,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { userKeys } from "../../../users/hooks/use-users";
import { renderCommentsRail } from "./session-comments-rail";
import type { TraceCommentItem } from "./trace-comments";

/**
 * ISS-5698: the session detail's comments SLOT, meaning the three-way routing
 * decision (nothing / collapsed handle / full rail), isolated from the page that
 * owns it.
 *
 * The routing is the whole subject here. `TraceCommentsRail` has its own story
 * file for what the open rail renders; this one pins the states that only exist
 * at the seam, and specifically the pair a reader is most likely to conflate:
 *
 *  - **hidden** (`open: false`). The user closed the panel. Nothing renders, not
 *    an empty rail claiming zero comments.
 *  - **collapsed at genuine zero**. The handle is there, and it deliberately
 *    drops its count pill rather than badging a `0`, so an unread-count glance
 *    reads "nothing waiting" instead of "a zero I have to interpret".
 *  - **open at genuine zero**. The rail's own empty copy, which says why there
 *    is nothing and what produces the first comment.
 *
 * The `.sd3` frame is load-bearing, not decoration: `styles.css` sizes the rail
 * off `--sd3-cmts-w`, declared on `.sd3`, and both the rail and the collapsed
 * handle are `height: 100%` flex children of it. Mounted bare they collapse to
 * nothing and the story would give no coverage of the width the production slot
 * actually occupies.
 */
const detailShellDecorator: Decorator = (Story) => (
  <div className="sd3 h-96 bg-background">
    <div className="sd3-main" />
    <Story />
  </div>
);

/**
 * The org member read the open rail resolves @-mentions through, seeded into the
 * story QueryClient under the hook's OWN key so the rail never issues a fetch
 * mid-`play`. Empty is the honest shape for these stories: none of the comments
 * below carry mentions, and the rail's mention matrix belongs to
 * `trace-comments-rail.stories.tsx`.
 */
const USERS_QUERY_DATA = [[userKeys.organizationUsers(), []]] as const;

const meta = {
  title: "App Core/Agents/Session Comments Rail",
  component: SessionCommentsRail,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
    appCore: { queryData: USERS_QUERY_DATA },
  },
  decorators: [detailShellDecorator],
  args: {
    activeRow: null,
    collapsed: false,
    comments: [],
    onCollapse: fn(),
    onDelete: fn(),
    onExpand: fn(),
    onJump: fn(),
    onReply: fn(),
    onUpdate: fn(),
    onWidthChange: fn(),
    open: true,
    traceIdentity: "session-detail-1",
    width: 360,
  },
} satisfies Meta<typeof SessionCommentsRail>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The panel is closed. The slot renders NOTHING, no rail, no handle, no
 * placeholder, so the trace gets the full width back. Pinned because the
 * cheapest wrong implementation of "closed" is a zero-width rail that still
 * occupies a border and a scrollbar.
 */
export const Hidden: Story = {
  args: { open: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button")).not.toBeInTheDocument();
    await expect(canvas.queryByText("Comments")).not.toBeInTheDocument();
  },
};

/**
 * Collapsed with unread work waiting: the slim handle keeps a count pill so the
 * reader knows re-opening is worth it. Three is enough to size the pill without
 * exercising the overflow case below.
 */
export const CollapsedWithComments: Story = {
  args: { collapsed: true, comments: makeComments(3) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("3")).toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole("button", { name: "Show comments panel" })
    );
    await expect(args.onExpand).toHaveBeenCalled();
  },
};

/**
 * Collapsed at a GENUINE zero. The trace has been read and nothing was
 * anchored. The handle stays (the affordance must not vanish, or there is no way
 * back), but the count pill is dropped rather than rendering a `0` badge.
 *
 * Read against {@link CollapsedWithComments}: the difference between "3 waiting"
 * and "none waiting" has to be legible at a glance from the handle alone, which
 * is the only thing on screen in this state.
 */
export const CollapsedGenuineZero: Story = {
  args: { collapsed: true, comments: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Show comments panel" })
    ).toBeInTheDocument();
    await expect(canvas.queryByText("0")).not.toBeInTheDocument();
  },
};

/**
 * The overflow case for the pill: a heavily annotated trace. The count is
 * rendered in full rather than clipped to `99+`, and the pill has to grow
 * without pushing the handle off its 6px gutter.
 */
export const CollapsedHighCount: Story = {
  args: { collapsed: true, comments: makeComments(128) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("128")).toBeInTheDocument();
  },
};

/**
 * Open at a genuine zero. Distinct from {@link CollapsedGenuineZero} and from
 * {@link Hidden} on purpose: this is the state that has to SAY why the stream is
 * empty and how a comment gets made, because a bare "Comments 0" reads as a
 * failed load.
 */
export const OpenGenuineZero: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No trace comments yet")).toBeInTheDocument();
    await expect(
      canvas.getByText("Select trace text to anchor the next comment.")
    ).toBeInTheDocument();
  },
};

/**
 * The populated open rail, which is what the slot routes to almost always. The
 * collapse control is the one interaction this seam owns (the rail's own
 * controls are covered in its story file), so the `play` drives it.
 */
export const OpenWithComments: Story = {
  args: { comments: makeComments(3) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("3")).toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole("button", { name: "Collapse comments panel" })
    );
    await expect(args.onCollapse).toHaveBeenCalled();
  },
};

/**
 * Production-length bodies and anchor quotes in the 360px rail. The rail is the
 * narrowest column on the detail screen, so this is where an un-wrapped quote or
 * an un-clipped body breaks the layout, and it is not reachable from a
 * three-word fixture.
 */
export const OpenWithLongBodies: Story = {
  args: {
    comments: [
      makeComment({
        anchorText:
          "await this.gateway.forceArchiveOversized({ externalSessionId, fileKey })",
        body: "This is the branch that swallows the transport rejection. It resolves to `unavailable` before the mutation ever reaches the gateway, so the button re-enables and the panel keeps claiming the transcript can still be synced from this machine.",
        id: "comment-long-1",
      }),
      makeComment({
        anchorText: "return { kind: 'unavailable' as const };",
        body: "Second pass: the same defect shows up on the retry path, and the notice copy below it says 'you can try again', which is only true for the retryable result, not this one.",
        id: "comment-long-2",
      }),
    ],
  },
};

/**
 * The slot's routing, as a component, so Storybook can render it and the catalog
 * can map this file to `session-comments-rail.tsx`. `renderCommentsRail` is a
 * render FUNCTION rather than a component in production (it is called inline by
 * `AgentSessionDetailView`), and calling it through a wrapper is the only way to
 * exercise the real decision instead of re-deriving it here.
 */
function SessionCommentsRail(
  props: Parameters<typeof renderCommentsRail>[0]
): ReturnType<typeof renderCommentsRail> {
  return renderCommentsRail(props);
}

/**
 * `count` interchangeable comments, for the states where the COUNT is the
 * subject (the collapsed pill, the header tally). Deliberately thin: the rich
 * per-comment matrix (mentions, replies, ownership, sort) belongs to
 * `trace-comments-rail.stories.tsx`, which owns that component.
 */
function makeComments(count: number): TraceCommentItem[] {
  const comments: TraceCommentItem[] = [];
  for (let index = 0; index < count; index += 1) {
    comments.push(
      makeComment({
        anchorText: `resolveFetchUrl(${index})`,
        body: `Anchored note on trace row ${index}.`,
        id: `comment-${index}`,
      })
    );
  }
  return comments;
}

/** One persisted trace comment in the display shape the rail renders. */
function makeComment({
  anchorText,
  body,
  id,
}: {
  anchorText: string;
  body: string;
  id: string;
}): TraceCommentItem {
  return {
    anchor: {
      actor: null,
      endOffset: anchorText.length,
      row: 3,
      selectedText: anchorText,
      sessionId: "session-detail-1",
      sourceText: anchorText,
      startOffset: 0,
      traceId: "trace-session-detail-1",
      turnId: "turn-3",
    },
    artifactId: "session-detail-1",
    authorAvatarUrl: null,
    authorId: "user-1",
    authorName: "Ada Lovelace",
    body,
    canDelete: true,
    canEdit: true,
    createdAt: "2026-06-10T12:30:00.000Z",
    createdAtLabel: "2 hours ago",
    editedAt: null,
    id,
    kind: TraceCommentKind.Comment,
    replies: [],
    resolvedAt: null,
    resolvedByAvatarUrl: null,
    resolvedById: null,
    resolvedByName: null,
    status: ThreadStatus.Open,
    surface: TraceCommentSurface.SessionDetail,
    target: { id: "session-detail-1", type: TraceCommentTargetType.Session },
    threadId: `thread-${id}`,
    updatedAt: "2026-06-10T12:30:00.000Z",
  };
}

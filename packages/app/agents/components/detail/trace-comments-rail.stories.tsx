import {
  ThreadStatus,
  TraceCommentKind,
  TraceCommentSurface,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import { ApproverRole, type User } from "@repo/api/src/types/user";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { userKeys } from "../../../users/hooks/use-users";
import type { TraceCommentItem } from "./trace-comments";
import { TraceCommentsRail } from "./trace-comments-rail";

/**
 * ISS-5698: the persisted trace-comments rail, isolated.
 *
 * `__tests__/trace-comments-rail.test.tsx` already pins the behavior: sort
 * order, mention resolution, which controls a non-owner sees. What it cannot
 * answer is whether the rail READS right at its production width: 360px is the
 * narrowest column on the detail screen, and every state below competes for it
 * with an anchor quote, an author line, a body, mention chips, and a reply
 * thread.
 *
 * The states that most need looking at rather than asserting:
 *
 *  - **empty vs unresolved**. Zero comments is a genuine zero and says so. A
 *    populated rail whose ORG MEMBER read came back empty is a different
 *    failure. The comments are there and every @-chip degrades to "Unknown
 *    user". Both have a `0`-shaped smell and neither should be mistaken for the
 *    other.
 *  - **the heading**. The rail's title is a real `h2`, which is invisible on
 *    screen and decisive for a screen reader's document outline — so it needs an
 *    assertion rather than a screenshot.
 *
 * The `.sd3` frame is load-bearing: `styles.css` sizes the rail off
 * `--sd3-cmts-w`, declared on `.sd3`, and the rail is a `height: 100%` flex
 * child of it. Mounted bare it collapses and none of the crowding above is
 * reachable.
 */
const detailShellDecorator: Decorator = (Story) => (
  <div className="sd3 h-96 bg-background">
    <div className="sd3-main" />
    <Story />
  </div>
);

const OLDER_ID = "comment-older";
const OLDER_ROW = 3;
const OLDER_BODY = "The retry path never clears the dead-letter marker.";
const THREADED_ROW = 12;
const THREADED_BODY = "This tally does not reconcile with the table below it.";

/** The org members the rail resolves persisted @-mention IDs against. */
const STORY_USERS: User[] = [
  makeUser({
    email: "ada@example.com",
    firstName: "Ada",
    id: "user-1",
    lastName: "Lovelace",
  }),
  makeUser({
    email: "grace@example.com",
    firstName: "Grace",
    id: "user-2",
    lastName: "Hopper",
  }),
];

/**
 * Seeds the org member read under `useOrganizationUsers`' OWN query key, so the
 * rail resolves mention labels from cache and never issues a fetch mid-`play`.
 */
const RESOLVED_USERS_PARAMETERS = {
  appCore: { queryData: [[userKeys.organizationUsers(), STORY_USERS]] },
};

/** The same read having returned nothing, so every mention degrades to a fallback. */
const NO_USERS_PARAMETERS = {
  appCore: { queryData: [[userKeys.organizationUsers(), []]] },
};

const meta = {
  title: "App Core/Agents/Trace Comments Rail",
  component: TraceCommentsRail,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [detailShellDecorator],
  args: {
    activeRow: null,
    comments: [],
    onCollapse: fn(),
    onDelete: fn(),
    onJump: fn(),
    onReply: fn(),
    onUpdate: fn(),
    onWidthChange: fn(),
    traceIdentity: "session-detail-1",
    width: 360,
  },
} satisfies Meta<typeof TraceCommentsRail>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The everyday rail: two root comments, one carrying a reply thread and resolved
 * @-mention chips on both levels. The header tally, the anchor quotes and the
 * chips all share the 360px track, which is the layout this story exists to
 * check.
 */
export const Populated: Story = {
  args: { comments: [threadedComment(), olderComment()] },
  parameters: RESOLVED_USERS_PARAMETERS,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("2")).toBeInTheDocument();
    const chips = canvas.getAllByTestId("trace-mention-chips");
    await expect(chips[0]).toHaveTextContent("Ada Lovelace");
    await expect(canvas.queryByText("Unknown user")).not.toBeInTheDocument();
  },
};

/**
 * A genuine zero: the read succeeded and the trace carries no anchored notes.
 * The rail says what is missing AND what produces the first one, because a bare
 * "Comments 0" is indistinguishable from a read that failed.
 */
export const EmptyGenuineZero: Story = {
  args: { comments: [] },
  parameters: RESOLVED_USERS_PARAMETERS,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No trace comments yet")).toBeInTheDocument();
    await expect(
      canvas.getByText("Select trace text to anchor the next comment.")
    ).toBeInTheDocument();
  },
};

/**
 * Comments present, org member read empty. Every chip falls back to "Unknown
 * user". The rail keeps the mention affordance rather than dropping the chips,
 * so the reader can see that someone WAS tagged and that this client cannot say
 * who.
 *
 * Read against {@link Populated}, which passes the same comments: the two differ
 * only in the seeded users, and this is what a failed or still-empty member read
 * costs the surface.
 */
export const MentionsUnresolvable: Story = {
  args: { comments: [threadedComment(), olderComment()] },
  parameters: NO_USERS_PARAMETERS,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // One on the root comment, one on its reply. Both mentions are persisted
    // IDs this client cannot name.
    await expect(canvas.getAllByText("Unknown user")).toHaveLength(2);
  },
};

/**
 * The rail's title is a real `h2`, so the `<aside>` landmark is named by a
 * heading and the detail page's outline reaches its third section. Nothing about
 * it is visible — `fp-title` carries the styling either way — which is exactly
 * why it needs an assertion rather than a screenshot. (ISS-5818; the gate that
 * made it conditional was retired by ISS-5999.)
 */
export const CommentsHeading: Story = {
  args: { comments: [olderComment()] },
  parameters: RESOLVED_USERS_PARAMETERS,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Comments"
    );
  },
};

/**
 * The sort toggle, driven. The rail sorts client-side over the already-fetched
 * list, so flipping it must re-order the rendered stream AND flip both the glyph
 * and `aria-pressed`. A control whose pressed state lies is worse than no
 * control. Comments are handed in oldest-first to prove the rail sorts rather
 * than trusting the incoming order.
 */
export const SortOldestFirst: Story = {
  args: { comments: [olderComment(), threadedComment()] },
  parameters: RESOLVED_USERS_PARAMETERS,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(renderedBodies(canvasElement)[0]).toBe(THREADED_BODY);

    await userEvent.click(
      canvas.getByRole("button", { name: "Sort comments (newest first)" })
    );

    await expect(renderedBodies(canvasElement)[0]).toBe(OLDER_BODY);
    await expect(
      canvas.getByRole("button", { name: "Sort comments (oldest first)" })
    ).toHaveAttribute("aria-pressed", "true");
  },
};

/**
 * Production-length prose in a 360px column: a multi-sentence body, a long
 * anchor quote, and a reply that runs past the card. This is where an unwrapped
 * quote or a body that refuses to clip breaks the rail, and it is not reachable
 * from a three-word fixture.
 */
export const LongBodies: Story = {
  args: { comments: [longComment()] },
  parameters: RESOLVED_USERS_PARAMETERS,
};

/**
 * A viewer who owns none of these comments AND a host that wired no mutation
 * callbacks: the read-only mount (an archived session, a shared link). Every
 * owned action is withheld rather than rendered disabled, so nothing on the card
 * looks interactive while doing nothing.
 *
 * Rendered explicitly rather than by nulling args: the point of the story is the
 * props the host DOES NOT pass, and a story arg set to `undefined` is a weaker
 * statement of that than simply not passing it.
 */
export const ReadOnlyViewer: Story = {
  args: {
    comments: [{ ...olderComment(), canDelete: false, canEdit: false }],
  },
  parameters: RESOLVED_USERS_PARAMETERS,
  render: (args) => (
    <TraceCommentsRail
      activeRow={args.activeRow}
      comments={args.comments}
      onCollapse={args.onCollapse}
      onJump={args.onJump}
      onWidthChange={args.onWidthChange}
      traceIdentity={args.traceIdentity}
      width={args.width}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("button", { name: "Edit trace note" })
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: "Delete trace note" })
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: "Reply to trace note" })
    ).not.toBeInTheDocument();
  },
};

/**
 * The comment whose anchor row is the trace's current position renders selected,
 * and clicking anywhere on the card jumps the trace back to that row with the
 * flash flag and the full anchor. The `play` asserts the whole jump payload,
 * because an anchor dropped on the way through lands the reader on the right ROW
 * of the wrong PASSAGE.
 */
export const ActiveAnchor: Story = {
  args: { activeRow: OLDER_ROW, comments: [olderComment()] },
  parameters: RESOLVED_USERS_PARAMETERS,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText(OLDER_BODY));
    await expect(args.onJump).toHaveBeenCalledWith(
      OLDER_ROW,
      true,
      olderComment().anchor
    );
  },
};

/**
 * The destructive action on a comment the viewer owns. Asserted through the spy
 * rather than the DOM: the rail does not remove the card itself (the host owns
 * the list), so the only evidence the control works is the id it reports.
 */
export const DeleteOwnedComment: Story = {
  args: { comments: [olderComment()] },
  parameters: RESOLVED_USERS_PARAMETERS,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Delete trace note" })
    );
    await expect(args.onDelete).toHaveBeenCalledWith(OLDER_ID);
  },
};

/** DOM order of the rendered root-comment bodies, for the sort assertions. */
function renderedBodies(canvasElement: HTMLElement): string[] {
  return Array.from(canvasElement.querySelectorAll(".fp-comment-text")).map(
    (node) => node.textContent ?? ""
  );
}

/** A full org member record, so the rail's mention map has real labels to use. */
function makeUser({
  email,
  firstName,
  id,
  lastName,
}: {
  email: string;
  firstName: string;
  id: string;
  lastName: string;
}): User {
  return {
    active: true,
    avatarUrl: null,
    clerkId: `clerk_${id}`,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    email,
    firstName,
    githubUsername: null,
    id,
    lastName,
    linearId: null,
    organizationId: "org-story",
    phoneNumber: null,
    role: ApproverRole.Engineer,
    slackId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

/** The older of the two root comments, owned by the viewer. */
function olderComment(): TraceCommentItem {
  return makeComment({
    anchorText: "if (!(force && externalSessionId)) { return null; }",
    body: OLDER_BODY,
    createdAt: "2026-06-10T15:00:00.000Z",
    id: OLDER_ID,
    row: OLDER_ROW,
  });
}

/** The newer root comment: a reply thread plus mentions on both levels. */
function threadedComment(): TraceCommentItem {
  return makeComment({
    anchorText: "const readableNow = result.kind === 'uploaded' && caughtUp;",
    body: THREADED_BODY,
    createdAt: "2026-06-10T16:00:00.000Z",
    id: "comment-threaded",
    mentions: ["user-1"],
    replies: [
      {
        authorAvatarUrl: null,
        authorId: "user-2",
        authorName: "Grace Hopper",
        body: "Confirmed against the projection. The aggregate counts a row the table filters out.",
        canDelete: true,
        canEdit: false,
        createdAt: "2026-06-10T16:20:00.000Z",
        createdAtLabel: "1 hour ago",
        editedAt: null,
        id: "reply-threaded-1",
        mentions: ["user-2"],
        threadId: "thread-comment-threaded",
        updatedAt: "2026-06-10T16:20:00.000Z",
      },
    ],
    row: THREADED_ROW,
  });
}

/** Production-length prose, for the crowding case. */
function longComment(): TraceCommentItem {
  return makeComment({
    anchorText:
      "await this.gateway.forceArchiveOversized({ externalSessionId, fileKey, allowOversized: true })",
    body: "The override reports success the moment the upload is accepted, not when the bytes land, so the panel flips to the rendered transcript while the cloud copy is still catching up. On a multi-megabyte transcript that window is long enough for the reader to see an empty trace and conclude the session was never recorded.",
    createdAt: "2026-06-10T17:00:00.000Z",
    id: "comment-long",
    replies: [
      {
        authorAvatarUrl: null,
        authorId: "user-1",
        authorName: "Ada Lovelace",
        body: "Same shape as the descriptor refetch: the caught-up flag is the only signal that separates readable-now from readable-eventually, and it is dropped one layer up.",
        canDelete: false,
        canEdit: false,
        createdAt: "2026-06-10T17:10:00.000Z",
        createdAtLabel: "40 minutes ago",
        editedAt: null,
        id: "reply-long-1",
        threadId: "thread-comment-long",
        updatedAt: "2026-06-10T17:10:00.000Z",
      },
    ],
    row: 41,
  });
}

/** One persisted trace comment in the display shape the rail renders. */
function makeComment({
  anchorText,
  body,
  createdAt,
  id,
  mentions,
  replies,
  row,
}: {
  anchorText: string;
  body: string;
  createdAt: string;
  id: string;
  mentions?: string[];
  replies?: TraceCommentItem["replies"];
  row: number;
}): TraceCommentItem {
  return {
    anchor: {
      actor: null,
      endOffset: anchorText.length,
      row,
      selectedText: anchorText,
      sessionId: "session-detail-1",
      sourceText: anchorText,
      startOffset: 0,
      traceId: "trace-session-detail-1",
      turnId: `turn-${row}`,
    },
    artifactId: "session-detail-1",
    authorAvatarUrl: null,
    authorId: "user-1",
    authorName: "Ada Lovelace",
    body,
    canDelete: true,
    canEdit: true,
    createdAt,
    createdAtLabel: "2 hours ago",
    editedAt: null,
    id,
    kind: TraceCommentKind.Comment,
    mentions,
    replies: replies ?? [],
    resolvedAt: null,
    resolvedByAvatarUrl: null,
    resolvedById: null,
    resolvedByName: null,
    status: ThreadStatus.Open,
    surface: TraceCommentSurface.SessionDetail,
    target: { id: "session-detail-1", type: TraceCommentTargetType.Session },
    threadId: `thread-${id}`,
    updatedAt: createdAt,
  };
}

import { ThreadStatus } from "@repo/api/src/types/comment";
import {
  CommentsSectionView,
  type CommentThreadItem,
} from "@repo/app/documents/components/comments-section";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";

const VIEWER_ID = "user-you";

const mentionNames = ["Avery Carter", "Jordan Lee", "Marcus Lee"];

/**
 * Creation time stamped on a comment or reply added through the `Threaded`
 * story's interactions (ISS-5286 — was `new Date().toISOString()`).
 *
 * Two things were wrong with a wall-clock `new Date()` here. The visible label
 * was fine (always a stable "Just now"), but the absolute `title` tooltip
 * (`formatDateTimeOrFallback`) lands in the DOM and differed every run.
 *
 * Pinned later than every seeded fixture (newest is `2026-05-29T16:18:00.000Z`)
 * so a just-posted item is newest by value, by sort position, and in that
 * tooltip. The meta args pin the view's `now` to this SAME instant, which is what
 * keeps the fresh-post state intact: the seeded fixtures read as "3 hours ago" /
 * "42 min ago" and a comment posted through the story's interactions reads "Just
 * now", exactly as a user sees it. Pinning `AUTHORED_AT` alone would have made
 * every timestamp render the same absolute "May 29, 2026" date, silently dropping
 * the one state the interaction exists to demonstrate.
 */
const AUTHORED_AT = "2026-05-29T17:00:00.000Z";

const comments: CommentThreadItem[] = [
  {
    id: "comment-1",
    authorId: "user-avery",
    status: ThreadStatus.Open,
    resolvedByName: null,
    participantIds: ["user-avery", VIEWER_ID],
    author: {
      name: "Avery Carter",
    },
    body: "The rollout section still needs an explicit fallback plan before we hand this to implementation. @Marcus Lee can you confirm the blast radius?",
    createdAt: "2026-05-29T13:45:00.000Z",
    replies: [
      {
        id: "comment-1-reply-1",
        authorId: VIEWER_ID,
        author: {
          name: "System Reviewer",
        },
        body: "Agreed. I also want the blast radius called out for each step of the rollout.",
        createdAt: "2026-05-29T14:02:00.000Z",
      },
    ],
  },
  {
    id: "comment-2",
    authorId: "user-jordan",
    status: ThreadStatus.Open,
    resolvedByName: null,
    participantIds: ["user-jordan"],
    author: {
      name: "Jordan Lee",
    },
    body: "Link the related implementation plan here once it is approved so future readers have the execution context.",
    createdAt: "2026-05-29T16:18:00.000Z",
  },
];

const resolvedThread: CommentThreadItem = {
  id: "comment-resolved",
  authorId: "user-avery",
  status: ThreadStatus.Resolved,
  resolvedByName: "Marcus Lee",
  participantIds: ["user-avery", "user-marcus"],
  author: { name: "Avery Carter" },
  body: "Does the single-writer queue become a bottleneck at fan-out?",
  createdAt: "2026-05-28T09:12:00.000Z",
  replies: [
    {
      id: "comment-resolved-reply-1",
      authorId: "user-marcus",
      author: { name: "Marcus Lee" },
      body: "Benchmarked at ~2k writes/s per queue; different docs stay parallel. Resolving.",
      createdAt: "2026-05-28T09:40:00.000Z",
    },
  ],
};

/**
 * A collapsible 'Comments' section on a document: open discussion threads at
 * the top, a link to show or hide resolved ones, and a composer at the
 * bottom for starting a new thread. Use it for artifact-level feedback and
 * discussion, complete with @mentions, replies, and a resolve or reopen
 * button on each thread for whoever started or replied to it. It shows
 * skeleton rows while the first load is in flight, so it never claims there
 * are no comments before it actually knows that.
 */
const meta = {
  title: "Composites/Documents/Comments Section",
  component: CommentsSectionView,
  tags: ["autodocs"],
  argTypes: {
    comments: { control: "object", table: { category: "Content" } },
    mentionNames: { control: "object", table: { category: "Content" } },
    open: { control: "boolean", table: { category: "State" } },
    isLoading: { control: "boolean", table: { category: "State" } },
    isSubmitting: { control: "boolean", table: { category: "State" } },
    isReplyPending: { control: "boolean", table: { category: "State" } },
    disabled: { control: "boolean", table: { category: "State" } },
    viewerId: { control: "text", table: { category: "State" } },
    now: { control: false, table: { category: "State" } },
    onOpenChange: { control: false, table: { category: "Events" } },
    onSubmitComment: { control: false, table: { category: "Events" } },
    onReply: { control: false, table: { category: "Events" } },
    onToggleResolved: { control: false, table: { category: "Events" } },
  },
  // The view resolves the current viewer through `useCurrentUser` to decide
  // reopen permission, so it needs the app-core ports mounted. Without them
  // every story in this file throws "Auth hooks require an
  // <AuthAdapterProvider> ancestor" on mount.
  args: {
    open: true,
    viewerId: VIEWER_ID,
    mentionNames,
    isLoading: false,
    disabled: false,
    isSubmitting: false,
    isReplyPending: false,
    // Same instant as AUTHORED_AT, so relative labels are deterministic AND a
    // just-posted comment still reads as new. See AUTHORED_AT above.
    now: new Date(AUTHORED_AT),
    onOpenChange: fn(),
    onSubmitComment: fn(),
  },
} satisfies Meta<typeof CommentsSectionView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Threaded: Story = {
  render: (args) => {
    function StatefulCommentsSection() {
      const [threadItems, setThreadItems] = useState(args.comments ?? comments);
      const [open, setOpen] = useState(true);

      return (
        <CommentsSectionView
          {...args}
          comments={threadItems}
          onOpenChange={setOpen}
          onReply={(threadId, body) => {
            setThreadItems((current) =>
              current.map((item) =>
                item.id === threadId
                  ? {
                      ...item,
                      replies: [
                        ...(item.replies ?? []),
                        {
                          id: `${threadId}-reply-${item.replies?.length ?? 0}`,
                          authorId: VIEWER_ID,
                          author: { name: "You" },
                          body,
                          createdAt: AUTHORED_AT,
                        },
                      ],
                    }
                  : item
              )
            );
          }}
          onSubmitComment={(body) => {
            setThreadItems((current) => [
              ...current,
              {
                id: `comment-${current.length + 1}`,
                authorId: VIEWER_ID,
                status: ThreadStatus.Open,
                resolvedByName: null,
                participantIds: [VIEWER_ID],
                author: { name: "You" },
                body,
                createdAt: AUTHORED_AT,
              },
            ]);
          }}
          onToggleResolved={(threadId, nextResolved) => {
            setThreadItems((current) =>
              current.map((item) =>
                item.id === threadId
                  ? {
                      ...item,
                      status: nextResolved
                        ? ThreadStatus.Resolved
                        : ThreadStatus.Open,
                      resolvedByName: nextResolved ? "You" : null,
                    }
                  : item
              )
            );
          }}
          open={open}
        />
      );
    }

    return <StatefulCommentsSection />;
  },
  args: {
    comments,
  },
};

export const Empty: Story = {
  args: {
    comments: [],
  },
};

/** Open threads plus a collapsed "resolved" group behind the toggle. */
export const WithResolved: Story = {
  args: {
    comments: [...comments, resolvedThread],
  },
};

/** A long body and a deep (15+) reply thread — the overflow states. */
export const LongThread: Story = {
  args: {
    comments: [
      {
        id: "comment-long",
        authorId: "user-avery",
        status: ThreadStatus.Open,
        resolvedByName: null,
        participantIds: ["user-avery"],
        author: { name: "Avery Carter" },
        body: "This section repeats the same migration caveat three times and buries the actual decision. We should collapse it to one paragraph that states the chosen backfill strategy, the rollback trigger, and the owner, then move the alternatives we rejected into an appendix so a first-time reader is not forced to reconstruct the argument to find the answer.",
        createdAt: "2026-05-20T10:00:00.000Z",
        replies: Array.from({ length: 16 }, (_, index) => ({
          id: `comment-long-reply-${index}`,
          authorId: `user-${index}`,
          author: { name: `Reviewer ${index + 1}` },
          body: `Reply ${index + 1}: agreed, and one more consideration for the backfill window.`,
          createdAt: "2026-05-20T10:05:00.000Z",
        })),
      },
    ],
  },
};

export const Submitting: Story = {
  args: {
    comments,
    isSubmitting: true,
  },
};

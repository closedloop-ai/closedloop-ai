import {
  CommentsSection,
  type CommentThreadItem,
} from "@repo/app/documents/components/comments-section";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

const comments: CommentThreadItem[] = [
  {
    id: "comment-1",
    author: {
      name: "Avery Carter",
    },
    body: "The rollout section still needs an explicit fallback plan before we hand this to implementation.",
    createdAt: "2026-05-29T13:45:00.000Z",
    replies: [
      {
        id: "comment-1-reply-1",
        author: {
          name: "System Reviewer",
          kind: "bot",
        },
        body: "Agreed. I also want the blast radius called out for each step of the rollout.",
        createdAt: "2026-05-29T14:02:00.000Z",
      },
    ],
  },
  {
    id: "comment-2",
    author: {
      name: "Jordan Lee",
    },
    body: "Link the related implementation plan here once it is approved so future readers have the execution context.",
    createdAt: "2026-05-29T16:18:00.000Z",
  },
];

const meta = {
  title: "App Core/Documents/Comments Section",
  component: CommentsSection,
  tags: ["autodocs"],
  args: {
    documentId: "doc_123",
    defaultOpen: true,
  },
} satisfies Meta<typeof CommentsSection>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: {
    comments: [],
  },
};

export const Threaded: Story = {
  render: (args) => {
    function StatefulCommentsSection() {
      const [threadItems, setThreadItems] = useState(args.comments ?? comments);
      const [draft, setDraft] = useState("");

      return (
        <CommentsSection
          {...args}
          comments={threadItems}
          draft={draft}
          onDraftChange={setDraft}
          onReply={(commentId, body) => {
            setThreadItems((current) =>
              current.map((item) =>
                item.id === commentId
                  ? {
                      ...item,
                      replies: [
                        ...(item.replies ?? []),
                        {
                          id: `${commentId}-reply-${item.replies?.length ?? 0}`,
                          author: { name: "You" },
                          body,
                          createdAt: new Date().toISOString(),
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
                author: { name: "You" },
                body,
                createdAt: new Date().toISOString(),
              },
            ]);
            setDraft("");
          }}
        />
      );
    }

    return <StatefulCommentsSection />;
  },
  args: {
    comments,
  },
};

export const Submitting: Story = {
  args: {
    comments,
    draft: "Following up with a blocked submission state",
    isSubmitting: true,
  },
};

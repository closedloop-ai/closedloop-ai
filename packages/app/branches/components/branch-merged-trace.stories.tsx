import type { MergedTraceItem } from "@repo/api/src/types/branch";
import type {
  TraceCommentItem,
  TraceTextAnchor,
} from "@repo/app/agents/components/detail/trace-comments";
import { TraceCommentsRail } from "@repo/app/agents/components/detail/trace-comments-rail";
import type { Meta, StoryObj } from "@storybook/react";
import type { CSSProperties } from "react";
import { useState } from "react";
import { BranchMergedTrace } from "./branch-merged-trace";

const traceItems: MergedTraceItem[] = [
  {
    type: "sessionstart",
    sessionId: "s1",
    t: "2026-06-10T10:00:00.000Z",
    actor: { name: "alice", harness: "claude" },
  },
  {
    type: "prompt",
    sessionId: "s1",
    t: "2026-06-10T10:00:30.000Z",
    tMs: 0,
    cumCostUsd: null,
    actorName: "alice",
    text: "Add the flags and examples.",
  },
  {
    type: "tools",
    sessionId: "s1",
    t: "2026-06-10T10:01:00.000Z",
    tMs: 0,
    endMs: 0,
    summary: "Edited 3 files",
    hasFail: false,
    failN: 0,
  },
  {
    type: "idle",
    sessionId: "s1",
    t: "2026-06-10T10:05:00.000Z",
    gapMs: 1_800_000,
  },
  {
    type: "sessionstart",
    sessionId: "ci1",
    t: "2026-06-10T10:35:00.000Z",
    actor: { name: null, harness: "ci", ci: true },
  },
  {
    type: "event",
    sessionId: "ci1",
    t: "2026-06-10T10:36:00.000Z",
    dot: "r",
    text: "CI failed — non-deterministic seed",
  },
  { type: "end", sessionId: "ci1", text: "Run complete" },
];

const meta = {
  title: "App Core/Branches/Merged Trace",
  component: BranchMergedTrace,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof BranchMergedTrace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { traceItems },
};

export const ActiveRow: Story = {
  args: { traceItems, activeRow: 1 },
};

export const Empty: Story = {
  args: { traceItems: [] },
};

export const PostedQuotedComment: Story = {
  args: { traceItems },
  render: () => <PostedQuotedCommentStory />,
};

function PostedQuotedCommentStory() {
  const anchor: TraceTextAnchor = {
    traceId: "trace:s1:1",
    turnId: "turn:v162w2",
    row: 1,
    selectedText: "flags and examples",
    sourceText: "Add the flags and examples.",
    startOffset: 8,
    endOffset: 26,
    sessionId: "s1",
    actor: { name: "alice", human: "alice" },
  };
  const [activeRow, setActiveRow] = useState<number | null>(1);
  const [highlightAnchor, setHighlightAnchor] =
    useState<TraceTextAnchor | null>(anchor);
  const [commentsWidth, setCommentsWidth] = useState(360);
  const [comments, setComments] = useState<TraceCommentItem[]>([
    {
      id: "story-trace-comment-1",
      threadId: "story-trace-thread-1",
      target: { type: "branch", id: "story-branch" },
      artifactId: "story-branch",
      surface: "branch_detail",
      anchor,
      body: "This quote stays anchored to the selected source passage.",
      status: "OPEN",
      createdAt: "2026-06-17T10:06:00.000Z",
      updatedAt: "2026-06-17T10:06:00.000Z",
      editedAt: null,
      authorId: "story-user",
      authorName: "Alice",
      authorAvatarUrl: null,
      canEdit: true,
      canDelete: true,
      createdAtLabel: "now",
      replies: [],
    },
  ]);

  return (
    <div
      className="bq-sessions-workspace sd3 min-h-[520px]"
      style={{ "--sd3-cmts-w": `${commentsWidth}px` } as CSSProperties}
    >
      <div className="sd3-main">
        <BranchMergedTrace
          activeRow={activeRow}
          highlightAnchor={highlightAnchor}
          onJump={setActiveRow}
          onSubmitTraceComment={(draft) => {
            setActiveRow(draft.anchor.row);
            setHighlightAnchor(draft.anchor);
            setComments((current) => [
              ...current,
              {
                id: `story-trace-comment-${current.length + 1}`,
                threadId: `story-trace-thread-${current.length + 1}`,
                target: { type: "branch", id: "story-branch" },
                artifactId: "story-branch",
                surface: "branch_detail",
                ...draft,
                status: "OPEN",
                createdAt: "2026-06-17T10:06:00.000Z",
                updatedAt: "2026-06-17T10:06:00.000Z",
                editedAt: null,
                authorId: "story-user",
                authorName: "Alice",
                authorAvatarUrl: null,
                canEdit: true,
                canDelete: true,
                createdAtLabel: "now",
                replies: [],
              },
            ]);
          }}
          traceItems={traceItems}
        />
      </div>
      <TraceCommentsRail
        activeRow={activeRow}
        comments={comments}
        onJump={(row, _flash, nextAnchor) => {
          setActiveRow(row);
          setHighlightAnchor(nextAnchor ?? null);
        }}
        onWidthChange={setCommentsWidth}
        width={commentsWidth}
      />
    </div>
  );
}

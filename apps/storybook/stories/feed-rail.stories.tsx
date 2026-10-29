import { CommentAvatar } from "@repo/app/shared/components/comment-avatar";
import {
  CommentThreadAnchorPreview,
  CommentThreadBanner,
  CommentThreadCard,
  CommentThreadHeader,
  CommentThreadMain,
} from "@repo/design-system/components/ui/comment-thread";
import {
  FeedRail,
  type FeedRailMode,
} from "@repo/design-system/components/ui/feed-rail";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";

/**
 * The fixture's real shape: only the "anchored-thread" item carries a version
 * banner and an anchored code preview, so both fields are optional here rather
 * than typed from the first (non-anchored) literal in the array — that is what
 * left `item.versionLabel` / `item.anchorPreview` unrecognized below.
 */
type FeedItemFixture = {
  id: string;
  author: string;
  timestamp: string;
  label: string;
  body: string;
  anchorPreview?: string;
  versionLabel?: string;
};

const feedItems: FeedItemFixture[] = [
  {
    id: "rollout-comment",
    author: "Avery Carter",
    timestamp: "2 hours ago",
    label: "Rollout comment",
    body: "We still need the rollback trigger called out before this ships.",
  },
  {
    id: "anchored-thread",
    author: "Jordan Lee",
    timestamp: "90 minutes ago",
    label: "Anchored thread",
    anchorPreview: "if (shouldRetry) return enqueueRetry(task)",
    versionLabel: "from v2",
    body: "This branch should explain what happens when the retry budget is exhausted.",
  },
  {
    id: "general-conversation",
    author: "System Reviewer",
    timestamp: "45 minutes ago",
    label: "General conversation",
    body: "I can summarize the open concerns into a release checklist.",
  },
];

function FeedRailStory({ mode }: { mode?: FeedRailMode }) {
  const [width, setWidth] = useState(380);

  return (
    <div className="relative h-[560px] overflow-hidden rounded-lg border bg-background">
      <FeedRail
        feedPanel={
          <>
            <div className="border-b px-3 py-2 text-muted-foreground text-xs">
              Feed filters mock
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
              {feedItems.map((item) => (
                <CommentThreadCard interactive key={item.id} onClick={fn()}>
                  {item.versionLabel ? (
                    <CommentThreadBanner>
                      <span className="rounded border bg-background px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
                        {item.versionLabel}
                      </span>
                    </CommentThreadBanner>
                  ) : null}
                  {item.anchorPreview ? (
                    <CommentThreadAnchorPreview>
                      {item.anchorPreview}
                    </CommentThreadAnchorPreview>
                  ) : null}
                  <CommentThreadMain
                    avatar={
                      <CommentAvatar
                        author={item.author}
                        authorAvatar={null}
                        authorKind={
                          item.author === "System Reviewer" ? "bot" : undefined
                        }
                        size="sm"
                      />
                    }
                    content={
                      <>
                        <div className="font-medium text-sm">{item.label}</div>
                        <CommentThreadHeader
                          author={
                            <span className="font-semibold text-[13px] text-foreground">
                              {item.author}
                            </span>
                          }
                          metadata={
                            <span className="text-muted-foreground text-xs">
                              {item.timestamp}
                            </span>
                          }
                        />
                        <div className="text-muted-foreground text-xs">
                          {item.body}
                        </div>
                      </>
                    }
                  />
                </CommentThreadCard>
              ))}
            </div>
            <div className="border-t px-3 py-3 text-muted-foreground text-xs">
              Composer slot mock
            </div>
          </>
        }
        mode={mode}
        onClose={() => undefined}
        onWidthChange={setWidth}
        visible
        width={width}
      />
    </div>
  );
}

const meta = {
  title: "Composites v1.0/Documents/Feed Rail",
  component: FeedRailStory,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FeedRailStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/**
 * FEA-3865: the mobile bottom-sheet layout. Below the `sm` breakpoint the
 * adaptive `inline` mode resolves to this on its own; forcing `mode="sheet"`
 * shows it at any width. The pointer resize handle is gone (a sheet has no
 * draggable edge) and the panel opens from the bottom with a scrim + Escape.
 */
export const Sheet: Story = {
  render: () => <FeedRailStory mode="sheet" />,
};

/**
 * FEA-3865: the fixed-width right-hand panel the adaptive `inline` mode
 * resolves to at `sm`..`lg` viewports — too narrow to give the rail its own
 * resizable track beside the document, too wide for the bottom sheet. Forcing
 * `mode="overlay"` shows it at any width. It floats over the content behind a
 * click-to-close scrim rather than sharing the row with it, and like the
 * sheet it drops the pointer resize handle — there is no adjacent track to
 * resize against.
 */
export const Overlay: Story = {
  render: () => <FeedRailStory mode="overlay" />,
};

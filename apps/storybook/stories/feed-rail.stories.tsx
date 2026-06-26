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
  FeedRailTab,
} from "@repo/design-system/components/ui/feed-rail";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";

const feedItems = [
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
] as const;

function FeedRailStory() {
  const [activeTab, setActiveTab] = useState<FeedRailTab>(FeedRailTab.Feed);
  const [width, setWidth] = useState(380);

  return (
    <div className="relative h-[560px] overflow-hidden rounded-lg border bg-background">
      <FeedRail
        activeTab={activeTab}
        chatPanel={
          <div className="flex h-full items-center justify-center border-t text-muted-foreground text-sm">
            Chat panel mock
          </div>
        }
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
        hasChat
        onClose={() => undefined}
        onTabChange={setActiveTab}
        onWidthChange={setWidth}
        visible
        width={width}
      />
    </div>
  );
}

const meta = {
  title: "Design System/Documents & Conversation/Feed Rail",
  component: FeedRailStory,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FeedRailStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

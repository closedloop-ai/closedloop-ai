import { CommentAvatar } from "@repo/app/shared/components/comment-avatar";
import {
  CommentThreadAnchorPreview,
  CommentThreadBanner,
  CommentThreadCard,
  CommentThreadCollapseFooter,
  CommentThreadHeader,
  CommentThreadMain,
  CommentThreadReplies,
  CommentThreadReplyRow,
} from "@repo/design-system/components/ui/comment-thread";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

function CommentThreadStory() {
  return (
    <div className="max-w-2xl space-y-4">
      <CommentThreadCard interactive onClick={fn()} selected>
        <CommentThreadBanner>
          <span className="rounded border bg-background px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
            from v2
          </span>
        </CommentThreadBanner>
        <CommentThreadAnchorPreview>
          const shouldRetry = attempts &lt; maxRetries
        </CommentThreadAnchorPreview>
        <CommentThreadMain
          actions={
            <button
              className="rounded border px-2 py-1 text-xs"
              onClick={fn()}
              type="button"
            >
              Actions
            </button>
          }
          avatar={
            <CommentAvatar
              author="Avery Carter"
              authorAvatar={null}
              size="sm"
            />
          }
          content={
            <>
              <CommentThreadHeader
                author={
                  <span className="font-semibold text-[13px] text-foreground">
                    Avery Carter
                  </span>
                }
                metadata={
                  <>
                    <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase">
                      PR
                    </span>
                    <span className="text-muted-foreground text-xs">
                      2 hours ago
                    </span>
                  </>
                }
              />
              <p className="text-muted-foreground text-sm">
                This retry branch still needs to document how permanent failures
                surface to the operator.
              </p>
            </>
          }
        />
        <CommentThreadReplies label="2 replies">
          <CommentThreadReplyRow
            avatar={
              <CommentAvatar
                author="Jordan Lee"
                authorAvatar={null}
                size="sm"
              />
            }
            body={
              <p className="text-muted-foreground text-xs">
                Agreed. We should call out the alerting path too.
              </p>
            }
            header={
              <CommentThreadHeader
                author={
                  <span className="font-semibold text-foreground text-xs">
                    Jordan Lee
                  </span>
                }
                metadata={
                  <span className="text-[11px] text-muted-foreground">
                    90 minutes ago
                  </span>
                }
              />
            }
          />
          <CommentThreadReplyRow
            avatar={
              <CommentAvatar
                author="System Reviewer"
                authorAvatar={null}
                authorKind="bot"
                size="sm"
              />
            }
            body={
              <p className="text-muted-foreground text-xs">
                I can synthesize the current retry policy into the release
                notes.
              </p>
            }
            header={
              <CommentThreadHeader
                author={
                  <span className="font-semibold text-foreground text-xs">
                    System Reviewer
                  </span>
                }
                metadata={
                  <span className="text-[11px] text-muted-foreground">
                    1 hour ago
                  </span>
                }
              />
            }
          />
        </CommentThreadReplies>
        <CommentThreadCollapseFooter
          label="Collapse resolved conversation"
          onClick={fn()}
        />
      </CommentThreadCard>
    </div>
  );
}

const meta = {
  title: "Design System/Documents & Conversation/Comment Thread",
  component: CommentThreadStory,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof CommentThreadStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

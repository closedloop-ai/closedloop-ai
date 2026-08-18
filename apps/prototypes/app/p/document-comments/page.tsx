"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { FeedRail } from "@repo/design-system/components/ui/feed-rail";
import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { Inbox, MessageSquare } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { CommentRail } from "./components/comment-rail";
import { DocumentBody } from "./components/document-body";
import {
  type CommentThread,
  currentUser,
  documentMeta,
  threads as initialThreads,
  mentionLabelFor,
  ThreadScope,
} from "./mock";

// Default rail width (px) for the inline FeedRail at lg+. Matches the doc
// editor's feed-rail default.
const DEFAULT_RAIL_WIDTH = 360;

let nextLocalId = 0;
function makeLocalId(prefix: string): string {
  nextLocalId += 1;
  return `${prefix}-local-${nextLocalId}`;
}

function DocumentComments() {
  const [threads, setThreads] =
    useState<readonly CommentThread[]>(initialThreads);
  const [showResolved, setShowResolved] = useState(false);
  const [showComments, setShowComments] = useState(true);
  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL_WIDTH);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  // Artifact-composer draft, hoisted so hiding then reopening the rail (which
  // unmounts CommentRail) does not lose in-progress text.
  const [composerDraft, setComposerDraft] = useState("");
  // Inbox is the only mention notification channel (no email). Seeded > 0 so
  // the affordance shows how a fresh @-mention surfaces.
  const [inboxCount] = useState(1);
  const threadRefs = useRef(new Map<string, HTMLElement>());

  const openCount = useMemo(
    () => threads.filter((thread) => !thread.resolved).length,
    [threads]
  );

  function registerThreadRef(threadId: string, node: HTMLElement | null) {
    if (node) {
      threadRefs.current.set(threadId, node);
    } else {
      threadRefs.current.delete(threadId);
    }
  }

  function focusThread(threadId: string) {
    const thread = threads.find((candidate) => candidate.id === threadId);
    setShowComments(true);
    setActiveThreadId(threadId);
    // A resolved thread lives in the collapsed group; expand it so the anchor
    // click actually reveals the card it points at.
    if (thread?.resolved) {
      setShowResolved(true);
    }
    // Scroll the card into view after the rail/group has rendered.
    requestAnimationFrame(() => {
      threadRefs.current
        .get(threadId)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  function toggleResolved(threadId: string) {
    setThreads((prev) =>
      prev.map((thread) =>
        thread.id === threadId
          ? { ...thread, resolved: !thread.resolved }
          : thread
      )
    );
  }

  function deleteThread(threadId: string) {
    setThreads((prev) => prev.filter((thread) => thread.id !== threadId));
  }

  function editThread(threadId: string, body: string) {
    setThreads((prev) =>
      prev.map((thread) =>
        thread.id === threadId ? { ...thread, body } : thread
      )
    );
  }

  function replyToThread(threadId: string, body: string, mentions: string[]) {
    setThreads((prev) =>
      prev.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              replies: [
                ...thread.replies,
                {
                  id: makeLocalId("rp"),
                  author: currentUser,
                  body,
                  createdAt: new Date().toISOString(),
                  mentions: mentions.map((userId) => ({
                    userId,
                    label: mentionLabelFor(userId),
                  })),
                },
              ],
            }
          : thread
      )
    );
  }

  function addArtifactThread(body: string, mentions: string[]) {
    setThreads((prev) => [
      ...prev,
      {
        id: makeLocalId("th"),
        scope: ThreadScope.Artifact,
        anchorText: null,
        author: currentUser,
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        mentions: mentions.map((userId) => ({
          userId,
          label: mentionLabelFor(userId),
        })),
        replies: [],
      },
    ]);
  }

  const commentRail = (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <CommentRail
        activeThreadId={activeThreadId}
        composerDraft={composerDraft}
        onComment={addArtifactThread}
        onComposerDraftChange={setComposerDraft}
        onDelete={deleteThread}
        onEdit={editThread}
        onRegisterThreadRef={registerThreadRef}
        onReply={replyToThread}
        onResolveToggle={toggleResolved}
        onToggleResolved={() => setShowResolved((prev) => !prev)}
        showResolved={showResolved}
        threads={threads}
      />
    </div>
  );

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="font-semibold text-2xl tracking-tight">
            {documentMeta.title}
          </h1>
          <p className="text-muted-foreground text-sm">
            {documentMeta.updatedLabel} by {documentMeta.authorName}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="relative"
                onClick={() =>
                  toast.message("Inbox", {
                    description:
                      "Opens the mention inbox in the connected build.",
                  })
                }
                size="icon"
                variant="ghost"
              >
                <Inbox aria-hidden className="h-4 w-4" />
                <span className="sr-only">Notifications</span>
                {inboxCount > 0 ? (
                  <SidebarCountBadge
                    className="absolute -top-1 -right-1 ml-0 h-4 w-4"
                    count={inboxCount}
                  />
                ) : null}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {inboxCount} unread mention{inboxCount === 1 ? "" : "s"} in your
              inbox
            </TooltipContent>
          </Tooltip>
          <Button
            aria-expanded={showComments}
            className="gap-1.5"
            onClick={() => setShowComments((prev) => !prev)}
            size="sm"
            variant={showComments ? "secondary" : "outline"}
          >
            <MessageSquare aria-hidden className="h-3.5 w-3.5" />
            {showComments ? "Hide" : "Show"} comments
            <SidebarCountBadge className="ml-1 h-4 w-4" count={openCount} />
          </Button>
        </div>
      </header>

      {/* Body + comment rail. The rail mounts inside the shared FeedRail shell
          (packages/design-system/components/ui/feed-rail.tsx) so the production
          handoff targets the current feed-rail chrome — resize handle, header,
          overlay/sheet at narrow widths — rather than a hand-rolled split. The
          connected build's DocumentFeedRail wraps this same FeedRail with the
          Liveblocks comment source. */}
      <div className="flex min-h-[60svh] gap-8">
        <article className="min-w-0 flex-1">
          <h2 className="sr-only">Document body</h2>
          <DocumentBody
            activeThreadId={activeThreadId}
            onAnchorClick={focusThread}
          />
        </article>
        <FeedRail
          activeTab="feed"
          feedPanel={commentRail}
          hasChat={false}
          onClose={() => setShowComments(false)}
          onTabChange={() => {
            // Single Feed tab in this prototype; nothing to switch to.
          }}
          onWidthChange={setRailWidth}
          visible={showComments}
          width={railWidth}
        />
      </div>
    </main>
  );
}

export default DocumentComments;

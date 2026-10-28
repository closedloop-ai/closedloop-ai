import { BranchPrCommentKind } from "@repo/api/src/types/branch";
import { CommentSurface, CommentTargetType } from "@repo/api/src/types/comment";
import { type RenderResult, render } from "@testing-library/react";
import { vi } from "vitest";
import {
  BranchCommentSource,
  BranchCommentsTab,
  type BranchCommentsWorkspaceProps,
  type BranchCommentThread,
} from "../branch-comments-model";
import { BranchCommentsWorkspace } from "../branch-comments-workspace";

export function renderWorkspace(
  overrides: Partial<BranchCommentsWorkspaceProps> = {}
): RenderResult {
  return render(<BranchCommentsWorkspace {...makeProps(overrides)} />);
}

export function makeProps(
  overrides: Partial<BranchCommentsWorkspaceProps> = {}
): BranchCommentsWorkspaceProps {
  return {
    activeTab: BranchCommentsTab.Details,
    branchId: "branch-1",
    comments: [makeThread()],
    composerTarget: {
      anchor: makeAnchor(),
      target: {
        id: "branch-1",
        type: CommentTargetType.Branch,
      },
    },
    onClose: vi.fn(),
    onCreate: vi.fn(),
    onDeleteReply: vi.fn(),
    onDeleteThread: vi.fn(),
    onEditRoot: vi.fn(),
    onJump: vi.fn(),
    onReply: vi.fn(),
    onWidthChange: vi.fn(),
    open: true,
    renderedSessionIds: ["session-a"],
    returnFocusRef: { current: null },
    selectedPullRequestKey: "owner/repo#12",
    width: 380,
    ...overrides,
  };
}

export function makeThread(
  overrides: Partial<BranchCommentThread> = {}
): BranchCommentThread {
  return {
    anchor: makeAnchor(),
    author: makeAuthor("Maya Chen"),
    body: "Native root",
    canDeleteThread: true,
    canEditRoot: true,
    canReply: true,
    createdAtLabel: "10:00 AM",
    id: "thread-1",
    pullRequestKey: null,
    replies: [],
    source: BranchCommentSource.Platform,
    tab: BranchCommentsTab.Details,
    target: {
      id: "branch-1",
      type: CommentTargetType.Branch,
    },
    collectionQuery:
      overrides.tab === BranchCommentsTab.Sessions
        ? { surface: CommentSurface.BranchTimeline }
        : undefined,
    ...overrides,
  };
}

export function makeAuthor(name: string) {
  return { avatarUrl: null, id: name.toLowerCase(), name };
}

export function makeAnchor(label = "line 42", id = "anchor-1") {
  return {
    id,
    label,
    trace: {
      actor: null,
      endOffset: 20,
      row: 42,
      sessionId: "session-a",
      selectedText: "selected trace text",
      sourceText: "source selected trace text",
      startOffset: 0,
      traceId: "trace-1",
      turnId: "turn-1",
    },
  };
}

export function stubMatchMedia(matcher: (query: string) => boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        dispatchEvent: () => false,
        matches: matcher(query),
        media: query,
        onchange: null,
        removeEventListener: () => undefined,
        removeListener: () => undefined,
      }) as unknown as MediaQueryList
  );
}

export function makeProviderProvenance(
  overrides: Partial<NonNullable<BranchCommentThread["provider"]>> = {}
): NonNullable<BranchCommentThread["provider"]> {
  return {
    bodyTruncated: false,
    inReplyToId: null,
    kind: BranchPrCommentKind.Review,
    line: 42,
    login: "reviewer",
    path: "packages/app/comment.tsx",
    providerUrl: null,
    resolved: null,
    stale: false,
    threadId: "provider-thread",
    ...overrides,
  };
}

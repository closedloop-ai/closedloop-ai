import {
  type TraceComment,
  type TraceCommentDraft,
  TraceCommentKind,
  type TraceCommentTarget,
} from "@repo/api/src/types/comment";
import {
  createFakeTraceCommentsSource,
  traceCommentTargetKey,
} from "@repo/app/agents/data-source/__tests__/fake-trace-comments-source";
import type { TraceCommentsDataSource } from "@repo/app/agents/data-source/trace-comments-data-source";
import { TraceCommentsDataSourceProvider } from "@repo/app/agents/data-source/trace-comments-provider";
import type { ReactElement } from "react";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";

/**
 * Shared test helpers for the AgentSessionDetailView suites (the grandfathered
 * `agent-session-detail-view.test.tsx` and the colocated comments-rail file).
 * Owns the trace-comment fixture infrastructure and the provider/selection
 * helpers so neither suite re-declares them — one source of truth for the fake
 * data source, the seeded-comment map, and the rail control names.
 */

/** Inline trace-comment affordances / rail controls, matched exactly. */
export const INLINE_TRACE_COMMENT_PLACEHOLDER = /comment on this passage/i;
export const COMMENT_BUTTON_NAME_RE = /^comment$/i;
export const COLLAPSE_COMMENTS_BUTTON_NAME = /collapse comments panel/i;
export const SHOW_COMMENTS_BUTTON_NAME = /show comments panel/i;

/** The in-memory store the fake data source reads/writes, keyed by target. */
export const traceCommentsByTarget = new Map<string, TraceComment[]>();

export const fakeTraceCommentsSource = createFakeTraceCommentsSource({
  commentsByTarget: traceCommentsByTarget,
  makeTraceComment,
});

/** A data source whose create() always rejects (FEA-2479 failure-path specs). */
export const failingTraceCommentsSource: TraceCommentsDataSource = {
  ...fakeTraceCommentsSource,
  create: () => Promise.reject(new Error("create failed")),
};

/** Clear the seeded-comment store between tests. */
export function resetTraceComments(): void {
  traceCommentsByTarget.clear();
}

export function withProviders(
  ui: ReactElement,
  enabledFlags?: readonly string[],
  dataSource: TraceCommentsDataSource = fakeTraceCommentsSource
) {
  return (
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <TraceCommentsDataSourceProvider dataSource={dataSource}>
        {ui}
      </TraceCommentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

export function makeTraceComment(
  target: TraceCommentTarget,
  draft: TraceCommentDraft,
  index: number
): TraceComment {
  const createdAt = new Date(Date.UTC(2026, 5, 17, 10, index)).toISOString();
  return {
    id: `${target.type}-trace-comment-${index}`,
    threadId: `${target.type}-trace-thread-${index}`,
    target,
    artifactId: target.id,
    surface: target.type === "session" ? "session_detail" : "branch_detail",
    ...draft,
    kind: draft.kind ?? TraceCommentKind.Comment,
    status: "OPEN",
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    resolvedByAvatarUrl: null,
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    authorId: "user-test",
    authorName: "Test User",
    authorAvatarUrl: null,
    canEdit: true,
    canDelete: true,
    replies: [],
  };
}

/**
 * FEA-4233: seed one persisted trace comment on a session target so the rail
 * opens by default (the empty-session default is the slim collapsed handle).
 */
export function seedSessionTraceComment(sessionId: string): TraceComment {
  const target: TraceCommentTarget = { type: "session", id: sessionId };
  const key = traceCommentTargetKey(target);
  const existing = traceCommentsByTarget.get(key) ?? [];
  const comment = makeTraceComment(
    target,
    {
      body: "Seeded trace comment",
      kind: TraceCommentKind.Comment,
      anchor: {
        traceId: sessionId,
        turnId: "seed-turn-0",
        row: 0,
        selectedText: "seed",
        sourceText: "seed",
        startOffset: 0,
        endOffset: 4,
      },
    },
    existing.length + 1
  );
  traceCommentsByTarget.set(key, [...existing, comment]);
  return comment;
}

export function selectRenderedText(container: HTMLElement, text: string): void {
  const node = findTextNode(container, text);
  if (!node) {
    throw new Error(`Unable to find text node: ${text}`);
  }
  const value = node.textContent ?? "";
  const start = value.indexOf(text);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  const selection = globalThis.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function findTextNode(node: Node, text: string): Text | null {
  if (node.nodeType === Node.TEXT_NODE && node.textContent?.includes(text)) {
    return node as Text;
  }
  for (const child of Array.from(node.childNodes)) {
    const found = findTextNode(child, text);
    if (found) {
      return found;
    }
  }
  return null;
}

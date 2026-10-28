import {
  ThreadStatus,
  type TraceComment,
  TraceCommentKind,
  type TraceCommentReply,
  type TraceTextAnchor,
} from "@repo/api/src/types/comment";
import type { RealtimeClientPort } from "@repo/realtime-client/port";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiAdapterProvider } from "../../../../shared/api/provider";
import { AuthAdapterProvider } from "../../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../../shared/auth/static-auth-adapter";
import { RealtimeProvider } from "../../../../shared/realtime/realtime-provider";
import { userKeys } from "../../../../users/hooks/use-users";
import type { TraceCommentsDataSource } from "../../../data-source/trace-comments-data-source";
import { TraceCommentsDataSourceProvider } from "../../../data-source/trace-comments-provider";

/**
 * Shared fixtures for the trace-comments hook suites. Extracted when the poll
 * cadence tests (ISS-5022) pushed `use-trace-comments.test.ts` past the 1000-line
 * ceiling and the suite was split by concern; both halves plus the pure cadence
 * tests build the same comment shapes, so they build them from ONE definition.
 */

/**
 * Forces `document.hidden`/`visibilityState` to a fixed value WITHOUT dispatching
 * a `visibilitychange` event, modelling a desktop renderer whose visibility is
 * stuck. Descriptors are restored by the caller's `afterEach`.
 */
export function forceDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
}

/**
 * Restores the original `document.hidden`/`visibilityState` descriptors (or
 * deletes the mocked getter to fall back to jsdom's prototype getter when there
 * was no own descriptor), so a forced visibility state never leaks into other
 * tests sharing this jsdom environment.
 */
export function restoreDocumentVisibility(
  hidden: PropertyDescriptor | undefined,
  visibilityState: PropertyDescriptor | undefined
): void {
  if (hidden) {
    Object.defineProperty(document, "hidden", hidden);
  } else {
    // biome-ignore lint/performance/noDelete: restore jsdom's prototype getter
    delete (document as { hidden?: boolean }).hidden;
  }
  if (visibilityState) {
    Object.defineProperty(document, "visibilityState", visibilityState);
  } else {
    // biome-ignore lint/performance/noDelete: restore jsdom's prototype getter
    delete (document as { visibilityState?: string }).visibilityState;
  }
}

/**
 * `realtime` mounts a realtime client and seeds the current user's organization,
 * which the comments channel is addressed by (ISS-12275).
 */
export function createTraceCommentsWrapper(
  dataSource: TraceCommentsDataSource,
  realtime?: { port: RealtimeClientPort; organizationId: string }
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (realtime) {
    queryClient.setQueryData(userKeys.currentUser(), {
      organizationId: realtime.organizationId,
    });
  }
  return function Wrapper({ children }: { children: ReactNode }) {
    const apiAdapter = { resolveApiOrigin: () => "http://api.test" };
    return (
      <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
        <ApiAdapterProvider adapter={apiAdapter}>
          <QueryClientProvider client={queryClient}>
            <RealtimeProvider client={realtime?.port ?? null}>
              <TraceCommentsDataSourceProvider dataSource={dataSource}>
                {children}
              </TraceCommentsDataSourceProvider>
            </RealtimeProvider>
          </QueryClientProvider>
        </ApiAdapterProvider>
      </AuthAdapterProvider>
    );
  };
}

export function makeTraceComment(
  body: string,
  options: {
    anchor?: Partial<TraceTextAnchor>;
    createdAt?: Date | string;
    id?: string;
    replies?: TraceCommentReply[];
  } = {}
): TraceComment {
  const createdAt = options.createdAt ?? "2026-06-26T15:00:00.000Z";
  return {
    anchor: {
      traceId: "trace-1",
      turnId: "turn-1",
      row: 1,
      selectedText: "selected text",
      sourceText: "source selected text",
      startOffset: 7,
      endOffset: 20,
      sessionId: "session-1",
      actor: null,
      ...options.anchor,
    },
    artifactId: "session-1",
    authorAvatarUrl: null,
    authorId: "user-1",
    authorName: "Test User",
    body,
    createdAt: createdAt as string,
    editedAt: null,
    id: options.id ?? "comment-1",
    status: ThreadStatus.Open,
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    resolvedByAvatarUrl: null,
    kind: TraceCommentKind.Comment,
    surface: "session_detail",
    target: { type: "session", id: "session-1" },
    threadId: "thread-1",
    updatedAt: createdAt as string,
    canEdit: true,
    canDelete: true,
    replies: options.replies ?? [],
  };
}

export function makeTraceCommentReply(
  id: string,
  body: string
): TraceCommentReply {
  return {
    authorAvatarUrl: null,
    authorId: "user-1",
    authorName: "Test User",
    body,
    canDelete: true,
    canEdit: true,
    createdAt: "2026-06-26T15:01:00.000Z",
    editedAt: null,
    id,
    threadId: "thread-1",
    updatedAt: "2026-06-26T15:01:00.000Z",
  };
}

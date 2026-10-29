/**
 * ISS-11212: every persisted comment enum and the TypeScript const that the API
 * contract exports name the same members, in the shape of
 * `document-status-parity.test.ts`. A one-sided addition fails `pnpm typecheck`
 * (the `expectTypeOf` lines) and `pnpm test` (the runtime set comparison).
 */
import { GitHubCommentThreadKind } from "@repo/api/src/types/branch-view";
import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import { CommentAnchorState } from "@repo/api/src/types/comment-anchor";
import {
  CommentBodyFormat,
  CommentSyncDirection,
  CommentSyncProvider,
  CommentSyncStatus,
} from "@repo/api/src/types/comment-thread-dto";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  CommentAnchorState as PersistedCommentAnchorState,
  CommentBodyFormat as PersistedCommentBodyFormat,
  CommentSyncDirection as PersistedCommentSyncDirection,
  CommentSyncProvider as PersistedCommentSyncProvider,
  CommentSyncStatus as PersistedCommentSyncStatus,
  GitHubCommentThreadKind as PersistedGitHubCommentThreadKind,
  ThreadSource as PersistedThreadSource,
  ThreadStatus as PersistedThreadStatus,
} from "../generated/enums";

function members(values: Record<string, string>): Set<string> {
  return new Set(Object.values(values));
}

describe("the Prisma comment enums and the TypeScript consts agree", () => {
  test("CommentAnchorState", () => {
    expectTypeOf<PersistedCommentAnchorState>().toEqualTypeOf<CommentAnchorState>();
    expect(members(PersistedCommentAnchorState)).toEqual(
      members(CommentAnchorState)
    );
  });

  test("CommentBodyFormat", () => {
    expectTypeOf<PersistedCommentBodyFormat>().toEqualTypeOf<CommentBodyFormat>();
    expect(members(PersistedCommentBodyFormat)).toEqual(
      members(CommentBodyFormat)
    );
  });

  test("CommentSyncProvider", () => {
    expectTypeOf<PersistedCommentSyncProvider>().toEqualTypeOf<CommentSyncProvider>();
    expect(members(PersistedCommentSyncProvider)).toEqual(
      members(CommentSyncProvider)
    );
  });

  test("CommentSyncDirection", () => {
    expectTypeOf<PersistedCommentSyncDirection>().toEqualTypeOf<CommentSyncDirection>();
    expect(members(PersistedCommentSyncDirection)).toEqual(
      members(CommentSyncDirection)
    );
  });

  test("CommentSyncStatus", () => {
    expectTypeOf<PersistedCommentSyncStatus>().toEqualTypeOf<CommentSyncStatus>();
    expect(members(PersistedCommentSyncStatus)).toEqual(
      members(CommentSyncStatus)
    );
  });

  test("ThreadSource", () => {
    expectTypeOf<PersistedThreadSource>().toEqualTypeOf<ThreadSource>();
    expect(members(PersistedThreadSource)).toEqual(members(ThreadSource));
  });

  test("ThreadStatus", () => {
    expectTypeOf<PersistedThreadStatus>().toEqualTypeOf<ThreadStatus>();
    expect(members(PersistedThreadStatus)).toEqual(members(ThreadStatus));
  });

  test("GitHubCommentThreadKind", () => {
    expectTypeOf<PersistedGitHubCommentThreadKind>().toEqualTypeOf<GitHubCommentThreadKind>();
    expect(members(PersistedGitHubCommentThreadKind)).toEqual(
      members(GitHubCommentThreadKind)
    );
  });
});

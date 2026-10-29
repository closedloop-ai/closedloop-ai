import { TraceCommentKind } from "@repo/api/src/types/comment";
import {
  COMMENT_SOURCE_POLICIES,
  CommentCapability,
  CommentPolicyKey,
} from "@repo/api/src/types/comment-capabilities";
import { STAFF_EMAIL_DOMAIN } from "@repo/api/src/types/staff-email";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

import { mockWithDbCall } from "@/__tests__/utils/db-helpers";
import {
  type CommentLiveState,
  collectionCapabilities,
  createCommentLiveState,
  isCommentKindAvailable,
  itemPermissions,
} from "./comment-capabilities";

const VIEWER = "viewer-1";
const OTHER = "other-1";

function liveState(state: { staff?: boolean }): CommentLiveState {
  return {
    isStaff: () => Promise.resolve(state.staff ?? false),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the staff-only parsing_bug kind (PLN-2121 decision 5)", () => {
  it("grants it on a Session to staff only", async () => {
    await expect(
      isCommentKindAvailable(
        CommentPolicyKey.NativeSession,
        TraceCommentKind.ParsingBug,
        liveState({ staff: true })
      )
    ).resolves.toBe(true);
    await expect(
      isCommentKindAvailable(
        CommentPolicyKey.NativeSession,
        TraceCommentKind.ParsingBug,
        liveState({ staff: false })
      )
    ).resolves.toBe(false);
  });

  it("never grants it on a Branch, even to staff", async () => {
    await expect(
      isCommentKindAvailable(
        CommentPolicyKey.NativeBranch,
        TraceCommentKind.ParsingBug,
        liveState({ staff: true })
      )
    ).resolves.toBe(false);
  });

  it("reads the viewer's email once, org-scoped, however often it is asked", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValue({ email: `ada${STAFF_EMAIL_DOMAIN}` });
    mockWithDbCall({ user: { findFirst } });
    const state = createCommentLiveState({
      organizationId: "org-1",
      userId: VIEWER,
    });

    await expect(state.isStaff()).resolves.toBe(true);
    await expect(state.isStaff()).resolves.toBe(true);

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: VIEWER, organizationId: "org-1" },
      select: { email: true },
    });
  });
});

describe("collection capabilities", () => {
  it("answer every capability, and the kinds and anchors, for a non-staff Session viewer", async () => {
    const capabilities = await collectionCapabilities(
      CommentPolicyKey.NativeSession,
      liveState({ staff: false })
    );

    expect(capabilities).toEqual({
      [CommentCapability.CreateThread]: true,
      [CommentCapability.Reply]: true,
      [CommentCapability.Edit]: true,
      [CommentCapability.Delete]: true,
      [CommentCapability.Resolve]: true,
      [CommentCapability.Reopen]: true,
      [CommentCapability.React]: false,
      [CommentCapability.Attach]: false,
      [CommentCapability.Mention]: true,
      [CommentCapability.RetrySync]: true,
      [CommentCapability.LinkOut]: false,
      anchorKinds:
        COMMENT_SOURCE_POLICIES[CommentPolicyKey.NativeSession].anchorKinds,
      commentKinds: [TraceCommentKind.Comment],
    });
  });

  it("deny a mirrored GitHub resolve to every viewer", async () => {
    const capabilities = await collectionCapabilities(
      CommentPolicyKey.GithubBranch,
      liveState({ staff: true })
    );

    expect(capabilities[CommentCapability.Resolve]).toBe(false);
    expect(capabilities[CommentCapability.LinkOut]).toBe(true);
  });
});

describe("item permissions", () => {
  const flags = {
    [CommentCapability.CreateThread]: true,
    [CommentCapability.Reply]: true,
    [CommentCapability.Edit]: true,
    [CommentCapability.Delete]: true,
    [CommentCapability.Resolve]: true,
    [CommentCapability.Reopen]: true,
    [CommentCapability.React]: true,
    [CommentCapability.Attach]: true,
    [CommentCapability.Mention]: true,
    [CommentCapability.RetrySync]: true,
    [CommentCapability.LinkOut]: true,
  };

  it("grant edit and delete on own comments, retry-sync to the thread's author, and resolve and reopen to anyone", () => {
    const own = itemPermissions(CommentPolicyKey.NativeSession, flags, {
      viewerUserId: VIEWER,
      commentAuthorId: VIEWER,
      threadAuthorId: OTHER,
      threadParticipantIds: new Set([VIEWER, OTHER]),
    });
    const others = itemPermissions(CommentPolicyKey.NativeSession, flags, {
      viewerUserId: VIEWER,
      commentAuthorId: OTHER,
      threadAuthorId: VIEWER,
      threadParticipantIds: new Set([VIEWER, OTHER]),
    });

    expect(own).toEqual({
      canEdit: true,
      canDelete: true,
      canResolve: true,
      canReopen: true,
      canRetrySync: false,
    });
    expect(others).toEqual({
      canEdit: false,
      canDelete: false,
      canResolve: true,
      canReopen: true,
      canRetrySync: true,
    });
  });

  it("let a document participant resolve but only the author reopen", () => {
    const participant = itemPermissions(
      CommentPolicyKey.NativeDocument,
      flags,
      {
        viewerUserId: VIEWER,
        commentAuthorId: OTHER,
        threadAuthorId: OTHER,
        threadParticipantIds: new Set([VIEWER, OTHER]),
      }
    );
    const bystander = itemPermissions(CommentPolicyKey.NativeDocument, flags, {
      viewerUserId: VIEWER,
      commentAuthorId: OTHER,
      threadAuthorId: OTHER,
      threadParticipantIds: new Set([OTHER]),
    });

    expect(participant.canResolve).toBe(true);
    expect(participant.canReopen).toBe(false);
    expect(bystander.canResolve).toBe(false);
  });

  it("stay closed when the collection denies the capability", () => {
    const permissions = itemPermissions(
      CommentPolicyKey.NativeSession,
      { ...flags, [CommentCapability.Edit]: false },
      {
        viewerUserId: VIEWER,
        commentAuthorId: VIEWER,
        threadAuthorId: VIEWER,
        threadParticipantIds: new Set([VIEWER]),
      }
    );

    expect(permissions.canEdit).toBe(false);
    expect(permissions.canDelete).toBe(true);
  });
});

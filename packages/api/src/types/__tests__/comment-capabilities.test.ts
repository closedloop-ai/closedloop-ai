import { describe, expect, expectTypeOf, it } from "vitest";
import { TraceCommentKind } from "../comment";
import { CommentAnchorKind } from "../comment-anchor-kind";
import {
  CapabilityGrant,
  COMMENT_SOURCE_POLICIES,
  CommentCapability,
  CommentPolicyKey,
  type ItemPermissions,
} from "../comment-capabilities";

// ISS-11212 requirement 9 and PLN-2120's parity table, column order:
// native_session, native_branch, github_branch, native_document. Session
// Resolve/Reopen moved from None to Any by ISS-12516.
const { Any, Author, Mirrored, None, Own, Participant, Staff } =
  CapabilityGrant;
const PARITY: Record<CommentCapability, readonly CapabilityGrant[]> = {
  [CommentCapability.CreateThread]: [Any, Any, None, Any],
  [CommentCapability.Reply]: [Any, Any, None, Any],
  [CommentCapability.Edit]: [Own, Own, None, Own],
  [CommentCapability.Delete]: [Own, Own, None, Own],
  [CommentCapability.Resolve]: [Any, None, Mirrored, Participant],
  [CommentCapability.Reopen]: [Any, None, Mirrored, Author],
  [CommentCapability.React]: [None, None, None, Any],
  [CommentCapability.Attach]: [None, None, None, Any],
  [CommentCapability.Mention]: [Any, Any, None, Any],
  [CommentCapability.RetrySync]: [Author, Author, None, None],
  [CommentCapability.LinkOut]: [None, None, Any, None],
};
const POLICY_ORDER = [
  CommentPolicyKey.NativeSession,
  CommentPolicyKey.NativeBranch,
  CommentPolicyKey.GithubBranch,
  CommentPolicyKey.NativeDocument,
] as const;

describe("COMMENT_SOURCE_POLICIES", () => {
  it("matches the parity table", () => {
    for (const [capability, grants] of Object.entries(PARITY)) {
      const actual = POLICY_ORDER.map(
        (key) =>
          COMMENT_SOURCE_POLICIES[key].capabilities[
            capability as CommentCapability
          ]
      );
      expect({ capability, grants: actual }).toEqual({ capability, grants });
    }
    expect(
      POLICY_ORDER.map((key) => COMMENT_SOURCE_POLICIES[key].anchorKinds)
    ).toEqual([
      [CommentAnchorKind.Trace],
      [CommentAnchorKind.Trace],
      [CommentAnchorKind.Code, CommentAnchorKind.Artifact],
      [CommentAnchorKind.Artifact, CommentAnchorKind.Text],
    ]);
    expect(
      POLICY_ORDER.map((key) => COMMENT_SOURCE_POLICIES[key].commentKinds)
    ).toEqual([
      { [TraceCommentKind.Comment]: Any, [TraceCommentKind.ParsingBug]: Staff },
      { [TraceCommentKind.Comment]: Any, [TraceCommentKind.ParsingBug]: None },
      { [TraceCommentKind.Comment]: Any, [TraceCommentKind.ParsingBug]: None },
      { [TraceCommentKind.Comment]: Any, [TraceCommentKind.ParsingBug]: None },
    ]);
  });
});

describe("ItemPermissions", () => {
  it("has one flag per item-scoped capability", () => {
    expectTypeOf<ItemPermissions>().toEqualTypeOf<{
      canEdit: boolean;
      canDelete: boolean;
      canResolve: boolean;
      canReopen: boolean;
      canRetrySync: boolean;
    }>();
  });
});

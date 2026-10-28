import { z } from "zod";
import { TraceCommentKind } from "./comment.ts";
import { CommentAnchorKind } from "./comment-anchor-kind.ts";

export const CommentCapability = {
  CreateThread: "createThread",
  Reply: "reply",
  Edit: "edit",
  Delete: "delete",
  Resolve: "resolve",
  Reopen: "reopen",
  React: "react",
  Attach: "attach",
  Mention: "mention",
  RetrySync: "retrySync",
  LinkOut: "linkOut",
} as const;
export type CommentCapability =
  (typeof CommentCapability)[keyof typeof CommentCapability];

/** Who a static source policy grants a capability to, before live-state narrowing. */
export const CapabilityGrant = {
  None: "none",
  Any: "any",
  Own: "own",
  Author: "author",
  Participant: "participant",
  Mirrored: "mirrored",
  Staff: "staff",
} as const;
export type CapabilityGrant =
  (typeof CapabilityGrant)[keyof typeof CapabilityGrant];

export const CommentPolicyKey = {
  NativeSession: "native_session",
  NativeBranch: "native_branch",
  GithubBranch: "github_branch",
  /** PRD, plan and issue threads, native and Liveblocks-imported alike (PLN-2187 DD-3). */
  NativeDocument: "native_document",
} as const;
export type CommentPolicyKey =
  (typeof CommentPolicyKey)[keyof typeof CommentPolicyKey];

export const commentCapabilitySchema = z.enum(CommentCapability);
export const capabilityGrantSchema = z.enum(CapabilityGrant);
export const commentPolicyKeySchema = z.enum(CommentPolicyKey);

export type CommentSourcePolicy = {
  capabilities: Record<CommentCapability, CapabilityGrant>;
  anchorKinds: readonly CommentAnchorKind[];
  commentKinds: Record<TraceCommentKind, CapabilityGrant>;
};

/** ISS-11212 requirement 9 parity table, plus the documents row (PLN-2187 DD-3). */
export const COMMENT_SOURCE_POLICIES = {
  [CommentPolicyKey.NativeSession]: {
    capabilities: {
      [CommentCapability.CreateThread]: CapabilityGrant.Any,
      [CommentCapability.Reply]: CapabilityGrant.Any,
      [CommentCapability.Edit]: CapabilityGrant.Own,
      [CommentCapability.Delete]: CapabilityGrant.Own,
      // ISS-12516 (operator ruling 2026-10-14): any org member resolves and reopens a Session thread.
      [CommentCapability.Resolve]: CapabilityGrant.Any,
      [CommentCapability.Reopen]: CapabilityGrant.Any,
      [CommentCapability.React]: CapabilityGrant.None,
      [CommentCapability.Attach]: CapabilityGrant.None,
      [CommentCapability.Mention]: CapabilityGrant.Any,
      [CommentCapability.RetrySync]: CapabilityGrant.Author,
      [CommentCapability.LinkOut]: CapabilityGrant.None,
    },
    anchorKinds: [CommentAnchorKind.Trace],
    commentKinds: {
      [TraceCommentKind.Comment]: CapabilityGrant.Any,
      [TraceCommentKind.ParsingBug]: CapabilityGrant.Staff,
    },
  },
  [CommentPolicyKey.NativeBranch]: {
    capabilities: {
      [CommentCapability.CreateThread]: CapabilityGrant.Any,
      [CommentCapability.Reply]: CapabilityGrant.Any,
      [CommentCapability.Edit]: CapabilityGrant.Own,
      [CommentCapability.Delete]: CapabilityGrant.Own,
      [CommentCapability.Resolve]: CapabilityGrant.None,
      [CommentCapability.Reopen]: CapabilityGrant.None,
      [CommentCapability.React]: CapabilityGrant.None,
      [CommentCapability.Attach]: CapabilityGrant.None,
      [CommentCapability.Mention]: CapabilityGrant.Any,
      [CommentCapability.RetrySync]: CapabilityGrant.Author,
      [CommentCapability.LinkOut]: CapabilityGrant.None,
    },
    anchorKinds: [CommentAnchorKind.Trace],
    commentKinds: {
      [TraceCommentKind.Comment]: CapabilityGrant.Any,
      [TraceCommentKind.ParsingBug]: CapabilityGrant.None,
    },
  },
  [CommentPolicyKey.GithubBranch]: {
    capabilities: {
      [CommentCapability.CreateThread]: CapabilityGrant.None,
      [CommentCapability.Reply]: CapabilityGrant.None,
      [CommentCapability.Edit]: CapabilityGrant.None,
      [CommentCapability.Delete]: CapabilityGrant.None,
      [CommentCapability.Resolve]: CapabilityGrant.Mirrored,
      [CommentCapability.Reopen]: CapabilityGrant.Mirrored,
      [CommentCapability.React]: CapabilityGrant.None,
      [CommentCapability.Attach]: CapabilityGrant.None,
      [CommentCapability.Mention]: CapabilityGrant.None,
      [CommentCapability.RetrySync]: CapabilityGrant.None,
      [CommentCapability.LinkOut]: CapabilityGrant.Any,
    },
    anchorKinds: [CommentAnchorKind.Code, CommentAnchorKind.Artifact],
    commentKinds: {
      [TraceCommentKind.Comment]: CapabilityGrant.Any,
      [TraceCommentKind.ParsingBug]: CapabilityGrant.None,
    },
  },
  [CommentPolicyKey.NativeDocument]: {
    capabilities: {
      [CommentCapability.CreateThread]: CapabilityGrant.Any,
      [CommentCapability.Reply]: CapabilityGrant.Any,
      [CommentCapability.Edit]: CapabilityGrant.Own,
      [CommentCapability.Delete]: CapabilityGrant.Own,
      [CommentCapability.Resolve]: CapabilityGrant.Participant,
      [CommentCapability.Reopen]: CapabilityGrant.Author,
      [CommentCapability.React]: CapabilityGrant.Any,
      [CommentCapability.Attach]: CapabilityGrant.Any,
      [CommentCapability.Mention]: CapabilityGrant.Any,
      [CommentCapability.RetrySync]: CapabilityGrant.None,
      [CommentCapability.LinkOut]: CapabilityGrant.None,
    },
    anchorKinds: [CommentAnchorKind.Artifact, CommentAnchorKind.Text],
    commentKinds: {
      [TraceCommentKind.Comment]: CapabilityGrant.Any,
      [TraceCommentKind.ParsingBug]: CapabilityGrant.None,
    },
  },
} as const satisfies Record<CommentPolicyKey, CommentSourcePolicy>;

/** What a source can do on an artifact for this viewer, after live-state narrowing. */
export type CollectionCapabilities = Record<CommentCapability, boolean> & {
  anchorKinds: readonly CommentAnchorKind[];
  commentKinds: readonly TraceCommentKind[];
};

/** Which capabilities are decided per thread or comment; every capability has to answer. */
export const ITEM_SCOPED_CAPABILITIES = {
  [CommentCapability.CreateThread]: false,
  [CommentCapability.Reply]: false,
  [CommentCapability.Edit]: true,
  [CommentCapability.Delete]: true,
  [CommentCapability.Resolve]: true,
  [CommentCapability.Reopen]: true,
  [CommentCapability.React]: false,
  [CommentCapability.Attach]: false,
  [CommentCapability.Mention]: false,
  [CommentCapability.RetrySync]: true,
  [CommentCapability.LinkOut]: false,
} as const satisfies Record<CommentCapability, boolean>;

type ItemScopedCapability = {
  [K in CommentCapability]: (typeof ITEM_SCOPED_CAPABILITIES)[K] extends true
    ? K
    : never;
}[CommentCapability];

/** What this viewer can do to one thread or comment. */
export type ItemPermissions = {
  [K in ItemScopedCapability as `can${Capitalize<K>}`]: boolean;
};

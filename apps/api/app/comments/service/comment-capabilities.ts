import { TraceCommentKind } from "@repo/api/src/types/comment";
import {
  CapabilityGrant,
  COMMENT_SOURCE_POLICIES,
  type CollectionCapabilities,
  CommentCapability,
  type CommentPolicyKey,
  type CommentSourcePolicy,
  type ItemPermissions,
} from "@repo/api/src/types/comment-capabilities";
import { isStaffEmail } from "@repo/api/src/types/staff-email";
import { withDb } from "@repo/database";

/** Who is acting: the signed-in user, or the owner of the calling API key. */
export type CommentViewer = {
  organizationId: string;
  userId: string;
};

/**
 * The live state capabilities narrow on, each read at most once per request
 * and only when a decision depends on it.
 */
export type CommentLiveState = {
  isStaff(): Promise<boolean>;
};

export function createCommentLiveState(
  viewer: CommentViewer
): CommentLiveState {
  return {
    isStaff: once(async () => {
      const user = await withDb((db) =>
        db.user.findFirst({
          where: { id: viewer.userId, organizationId: viewer.organizationId },
          select: { email: true },
        })
      );
      return isStaffEmail(user?.email);
    }),
  };
}

/**
 * Whether the viewer can use `capability` on this source at all, before any
 * item is known. `own`, `author` and `participant` grants pass here and are
 * decided per item by {@link itemPermissions}.
 */
export function isCapabilityAvailable(
  policyKey: CommentPolicyKey,
  capability: CommentCapability,
  liveState: CommentLiveState,
  policies: CommentSourcePolicies = COMMENT_SOURCE_POLICIES
): Promise<boolean> {
  return isGrantAvailable(
    policies[policyKey].capabilities[capability],
    liveState
  );
}

/** PLN-2121 decision 5: the staff-only `parsing_bug` kind is decided here. */
export function isCommentKindAvailable(
  policyKey: CommentPolicyKey,
  kind: TraceCommentKind,
  liveState: CommentLiveState,
  policies: CommentSourcePolicies = COMMENT_SOURCE_POLICIES
): Promise<boolean> {
  return isGrantAvailable(policies[policyKey].commentKinds[kind], liveState);
}

export async function collectionCapabilities(
  policyKey: CommentPolicyKey,
  liveState: CommentLiveState,
  policies: CommentSourcePolicies = COMMENT_SOURCE_POLICIES
): Promise<CollectionCapabilities> {
  const can = (capability: CommentCapability) =>
    isCapabilityAvailable(policyKey, capability, liveState, policies);
  const flags: Record<CommentCapability, boolean> = {
    [CommentCapability.CreateThread]: await can(CommentCapability.CreateThread),
    [CommentCapability.Reply]: await can(CommentCapability.Reply),
    [CommentCapability.Edit]: await can(CommentCapability.Edit),
    [CommentCapability.Delete]: await can(CommentCapability.Delete),
    [CommentCapability.Resolve]: await can(CommentCapability.Resolve),
    [CommentCapability.Reopen]: await can(CommentCapability.Reopen),
    [CommentCapability.React]: await can(CommentCapability.React),
    [CommentCapability.Attach]: await can(CommentCapability.Attach),
    [CommentCapability.Mention]: await can(CommentCapability.Mention),
    [CommentCapability.RetrySync]: await can(CommentCapability.RetrySync),
    [CommentCapability.LinkOut]: await can(CommentCapability.LinkOut),
  };
  const commentKinds: TraceCommentKind[] = [];
  for (const kind of Object.values(TraceCommentKind)) {
    if (await isCommentKindAvailable(policyKey, kind, liveState, policies)) {
      commentKinds.push(kind);
    }
  }
  return {
    ...flags,
    anchorKinds: policies[policyKey].anchorKinds,
    commentKinds,
  };
}

/**
 * What the viewer can do to one comment, from the collection-level answer:
 * `own` is the comment's author, `author` the thread root's author, and
 * `participant` anyone who has commented on the thread.
 */
export function itemPermissions(
  policyKey: CommentPolicyKey,
  collection: Record<CommentCapability, boolean>,
  item: CommentItemActor,
  policies: CommentSourcePolicies = COMMENT_SOURCE_POLICIES
): ItemPermissions {
  const decide = (capability: CommentCapability) =>
    collection[capability] &&
    isItemGranted(policies[policyKey].capabilities[capability], item);
  return {
    canEdit: decide(CommentCapability.Edit),
    canDelete: decide(CommentCapability.Delete),
    canResolve: decide(CommentCapability.Resolve),
    canReopen: decide(CommentCapability.Reopen),
    canRetrySync: decide(CommentCapability.RetrySync),
  };
}

export function isItemGranted(
  grant: CapabilityGrant,
  item: CommentItemActor
): boolean {
  switch (grant) {
    case CapabilityGrant.Own:
      return item.commentAuthorId === item.viewerUserId;
    case CapabilityGrant.Author:
      return item.threadAuthorId === item.viewerUserId;
    case CapabilityGrant.Participant:
      return item.threadParticipantIds.has(item.viewerUserId);
    case CapabilityGrant.None:
    case CapabilityGrant.Mirrored:
      return false;
    case CapabilityGrant.Any:
    case CapabilityGrant.Staff:
      return true;
    default:
      return assertNever(grant);
  }
}

export type CommentSourcePolicies = Record<
  CommentPolicyKey,
  CommentSourcePolicy
>;

/** The viewer and the authorship an item-scoped grant is decided against. */
export type CommentItemActor = {
  viewerUserId: string;
  commentAuthorId: string;
  threadAuthorId: string | null;
  threadParticipantIds: ReadonlySet<string>;
};

/**
 * `mirrored` is a provider's own state shown read-only, so no viewer writes it;
 * `staff` needs the viewer's email; the item-scoped grants pass here.
 */
async function isGrantAvailable(
  grant: CapabilityGrant,
  liveState: CommentLiveState
): Promise<boolean> {
  switch (grant) {
    case CapabilityGrant.None:
    case CapabilityGrant.Mirrored:
      return false;
    case CapabilityGrant.Staff:
      return await liveState.isStaff();
    case CapabilityGrant.Any:
    case CapabilityGrant.Own:
    case CapabilityGrant.Author:
    case CapabilityGrant.Participant:
      return true;
    default:
      return assertNever(grant);
  }
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load();
    return pending;
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled capability grant: ${String(value)}`);
}

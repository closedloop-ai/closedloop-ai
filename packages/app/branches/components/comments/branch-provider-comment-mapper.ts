import type {
  BranchPrComment,
  BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import { BranchPrCommentKind } from "@repo/api/src/types/branch";
import { CommentTargetType } from "@repo/api/src/types/comment";
import {
  type PullRequestKeySelection,
  parsePullRequestKey,
} from "@repo/app/shared/components/comments/comments-pane-model";
import {
  type BranchCommentReply,
  BranchCommentSource,
  BranchCommentsTab,
  type BranchCommentThread,
  type BranchProviderCommentProvenance,
  type BranchProviderCommentsAvailability,
  formatBranchCommentTime,
} from "./branch-comments-model";

/** Selection-verified provider threads and independent availability evidence. */
export type BranchProviderCommentsView = {
  availability: BranchProviderCommentsAvailability;
  threads: BranchCommentThread[];
};

/** Maps one exact selected-PR response into the shared read-only comment view. */
export function mapSelectedProviderComments(
  response: BranchPrCommentsResponse | undefined,
  branchId: string,
  pullRequestKey: string | null | undefined
): BranchProviderCommentsView | null {
  const selection = parsePullRequestKey(pullRequestKey);
  if (
    !(
      selection &&
      pullRequestKey &&
      matchesProviderSelection(response, branchId, selection)
    )
  ) {
    return null;
  }

  const roots = response.comments.filter(
    (comment) => comment.inReplyToId === null
  );
  const rootById = new Map(
    roots.map((root) => [providerFamilyKey(root.kind, root.id), root])
  );
  const rootByThreadId = new Map<string, BranchPrComment>();
  for (const root of roots) {
    if (root.threadId && !rootByThreadId.has(root.threadId)) {
      rootByThreadId.set(root.threadId, root);
    }
  }
  const repliesByRootId = new Map<string, BranchPrComment[]>();
  const unmatchedReplies: BranchPrComment[] = [];
  for (const reply of response.comments) {
    if (reply.inReplyToId === null) {
      continue;
    }
    const root =
      rootById.get(
        providerFamilyKey(BranchPrCommentKind.Review, reply.inReplyToId)
      ) ?? (reply.threadId ? rootByThreadId.get(reply.threadId) : undefined);
    if (!root) {
      unmatchedReplies.push(reply);
      continue;
    }
    const rootKey = providerViewId(root);
    const replies = repliesByRootId.get(rootKey) ?? [];
    replies.push(reply);
    repliesByRootId.set(rootKey, replies);
  }

  const threads: BranchCommentThread[] = roots.map((comment) => ({
    ...mapProviderThread(comment, response.branchId, pullRequestKey, selection),
    replies: (repliesByRootId.get(providerViewId(comment)) ?? []).map((reply) =>
      mapProviderReply(reply, selection)
    ),
  }));
  threads.push(
    ...unmatchedReplies.map((comment) =>
      mapProviderThread(comment, response.branchId, pullRequestKey, selection)
    )
  );
  return {
    availability: mapProviderAvailability(response),
    threads,
  };
}

function matchesProviderSelection(
  response: BranchPrCommentsResponse | undefined,
  branchId: string,
  selection: PullRequestKeySelection
): response is BranchPrCommentsResponse {
  if (!(response && response.branchId === branchId)) {
    return false;
  }
  return (
    response.repositoryFullName?.toLocaleLowerCase() ===
      selection.repository.toLocaleLowerCase() &&
    response.prNumber === selection.number
  );
}

function mapProviderThread(
  comment: BranchPrComment,
  branchId: string,
  pullRequestKey: string,
  selection: PullRequestKeySelection
): BranchCommentThread {
  return {
    author: mapProviderAuthor(comment),
    body: comment.body,
    canDeleteThread: false,
    canEditRoot: false,
    canReply: false,
    createdAtLabel: formatBranchCommentTime(comment.createdAt),
    id: providerViewId(comment),
    provider: mapProviderProvenance(comment, selection),
    pullRequestKey,
    replies: [],
    source: BranchCommentSource.Provider,
    tab: BranchCommentsTab.Details,
    target: { id: branchId, type: CommentTargetType.Branch },
  };
}

function mapProviderReply(
  comment: BranchPrComment,
  selection: PullRequestKeySelection
): BranchCommentReply {
  return {
    author: mapProviderAuthor(comment),
    body: comment.body,
    canDelete: false,
    createdAtLabel: formatBranchCommentTime(comment.createdAt),
    id: providerViewId(comment),
    provider: mapProviderProvenance(comment, selection),
  };
}

function mapProviderAuthor(comment: BranchPrComment) {
  return {
    avatarUrl: comment.author.avatarUrl,
    id: comment.author.login,
    name: comment.author.displayName ?? comment.author.login,
  };
}

function mapProviderProvenance(
  comment: BranchPrComment,
  selection: PullRequestKeySelection
): BranchProviderCommentProvenance {
  return {
    bodyTruncated: comment.bodyTruncated,
    inReplyToId: comment.inReplyToId,
    kind: comment.kind,
    line: comment.line,
    login: comment.author.login,
    path: comment.path,
    providerUrl: safeProviderUrl(comment.providerUrl, selection),
    resolved: comment.resolved,
    stale: comment.stale,
    threadId: comment.threadId,
  };
}

function mapProviderAvailability(
  response: BranchPrCommentsResponse
): BranchProviderCommentsAvailability {
  return {
    bodyTruncatedCount: response.budget.bodyTruncatedCount,
    mixedProjection: response.mixedProjection,
    omittedComments: response.budget.omittedComments,
    providerTruncated: response.budget.providerTruncated,
    responseTruncated: response.budget.responseTruncated,
    stale: response.stale,
    state: response.state,
  };
}

function safeProviderUrl(
  value: string | null,
  selection: PullRequestKeySelection
): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    const expectedPullPath = `/${selection.repository}/pull/${selection.number}`;
    const expectedIssuePath = `/${selection.repository}/issues/${selection.number}`;
    const normalizedPath = url.pathname
      .replace(TRAILING_SLASH, "")
      .toLocaleLowerCase();
    if (
      url.protocol !== "https:" ||
      url.hostname.toLocaleLowerCase() !== GITHUB_HOSTNAME ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      (normalizedPath !== expectedPullPath.toLocaleLowerCase() &&
        normalizedPath !== expectedIssuePath.toLocaleLowerCase())
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function providerFamilyKey(kind: BranchPrCommentKind, id: string): string {
  const family =
    kind === BranchPrCommentKind.ReviewReply
      ? BranchPrCommentKind.Review
      : kind;
  return `${family}:${id}`;
}

function providerViewId(comment: BranchPrComment): string {
  const providerIdentity =
    comment.providerNodeId ??
    `${comment.kind}:${comment.providerCommentId ?? comment.id}`;
  return `provider:${providerIdentity}`;
}

const GITHUB_HOSTNAME = "github.com";
const TRAILING_SLASH = /\/$/;

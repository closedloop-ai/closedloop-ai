/**
 * ISS-11212 (PLN-2121 Step 5): the unified comment routes' requests, each
 * resolved and org-scoped to its target before it reaches a command, and
 * answered as the unified thread DTO.
 */

import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import type {
  CommentReactionEmoji,
  CommentThreadDto,
  CreateCommentThreadRequest,
  EditCommentRequest,
  ReplyToCommentThreadRequest,
} from "@repo/api/src/types/comment-thread-dto";
import { Result } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { branchHasCloudEligibility } from "@/app/branches/cloud-branch-eligibility";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import type { CreateCommentAttachmentRequest } from "../comment-attachment-request";
import {
  attachmentDownloadUrl,
  type CommentAttachmentUpload,
  type CommentAttachmentUploadError,
  completeUpload,
  createUpload,
} from "./comment-attachment-commands";
import {
  type CommentViewer,
  createCommentLiveState,
} from "./comment-capabilities";
import type { CommentWritten } from "./comment-command-pipeline";
import { createThread, reply } from "./comment-commands";
import {
  type CommentDeleteResult,
  deleteComment,
  editComment,
} from "./comment-edit-commands";
import { addReaction, removeReaction } from "./comment-reaction-commands";
import { presentCommentThreadDto } from "./comment-read";
import { resolveAndLatchDocumentCommentsSwitch } from "./comment-store-switch";
import {
  CommentArtifactType,
  type CommentTarget,
  resolveCommentIdTarget,
  resolveCommentTarget,
  resolveThreadCommentTarget,
  type SourcedCommentTarget,
} from "./comment-target";
import {
  reopenCommentThread,
  resolveCommentThread,
  retrySync,
} from "./comment-thread-state-commands";

type ThreadResult = Promise<Result<CommentThreadDto, CommentErrorCode>>;

/** The route's in-transaction receipt for a comment write (ISS-12552). */
type RecordComment = RecordWriteInTransaction<CommentWritten>;

export const unifiedCommentRequests = {
  async createArtifactCommentThread(
    input: {
      viewer: CommentViewer;
      artifactId: string;
      request: CreateCommentThreadRequest;
    },
    recordWrite?: RecordComment
  ): ThreadResult {
    const resolved = await writableOnly(
      await resolveCommentTarget({
        organizationId: input.viewer.organizationId,
        artifactId: input.artifactId,
      })
    );
    if (!resolved.ok) {
      return resolved;
    }
    const { request } = input;
    return createThread(
      {
        ...actorOn(input.viewer, resolved.value),
        surface: request.surface,
        anchor: request.anchor,
        body: request.body,
        mentions: request.mentions,
        kind: request.kind,
        clientId: request.clientId,
      },
      recordWrite
    );
  },

  async replyToCommentThread(
    input: {
      viewer: CommentViewer;
      threadId: string;
      request: ReplyToCommentThreadRequest;
    },
    recordWrite?: RecordComment
  ): ThreadResult {
    const located = await locateThread(input);
    if (!located.ok) {
      return located;
    }
    return reply(
      {
        ...actorOn(input.viewer, located.value.target),
        thread: { threadId: input.threadId },
        body: input.request.body,
        mentions: input.request.mentions,
        clientId: input.request.clientId,
      },
      recordWrite
    );
  },

  async editCommentById(
    input: {
      viewer: CommentViewer;
      commentId: string;
      request: EditCommentRequest;
    },
    recordWrite?: RecordComment
  ): ThreadResult {
    const located = await locateComment(input);
    if (!located.ok) {
      return located;
    }
    return editComment(
      {
        ...actorOn(input.viewer, located.value),
        commentId: input.commentId,
        body: input.request.body,
        mentions: input.request.mentions,
        expectedRevision: input.request.expectedRevision,
      },
      recordWrite
    );
  },

  async deleteCommentById(
    input: {
      viewer: CommentViewer;
      commentId: string;
    },
    recordWrite?: RecordComment
  ): Promise<Result<CommentDeleteResult, CommentErrorCode>> {
    const located = await locateComment(input);
    if (!located.ok) {
      return located;
    }
    return deleteComment(
      {
        viewer: input.viewer,
        target: located.value,
        commentId: input.commentId,
      },
      recordWrite
    );
  },

  async addReactionByCommentId(
    input: ReactionRequest,
    recordWrite?: RecordComment
  ): ThreadResult {
    const located = await locateComment(input);
    if (!located.ok) {
      return located;
    }
    return addReaction(
      {
        ...actorOn(input.viewer, located.value),
        commentId: input.commentId,
        emoji: input.emoji,
      },
      recordWrite
    );
  },

  async removeReactionByCommentId(
    input: ReactionRequest,
    recordWrite?: RecordComment
  ): ThreadResult {
    const located = await locateComment(input);
    if (!located.ok) {
      return located;
    }
    return removeReaction(
      {
        ...actorOn(input.viewer, located.value),
        commentId: input.commentId,
        emoji: input.emoji,
      },
      recordWrite
    );
  },

  async createCommentAttachmentUploadById(
    input: {
      viewer: CommentViewer;
      commentId: string;
      request: CreateCommentAttachmentRequest;
    },
    recordWrite?: RecordComment
  ): Promise<Result<CommentAttachmentUpload, CommentAttachmentUploadError>> {
    const located = await locateComment(input);
    if (!located.ok) {
      return located;
    }
    return createUpload(
      {
        ...actorOn(input.viewer, located.value),
        commentId: input.commentId,
        request: input.request,
      },
      recordWrite
    );
  },

  async completeCommentAttachmentUploadById(
    input: {
      viewer: CommentViewer;
      attachmentId: string;
    },
    recordWrite?: RecordComment
  ): ThreadResult {
    const located = await locateAttachment(input);
    if (!located.ok) {
      return located;
    }
    return completeUpload(
      {
        ...actorOn(input.viewer, located.value),
        attachmentId: input.attachmentId,
      },
      recordWrite
    );
  },

  getCommentAttachmentDownloadUrl(input: {
    viewer: CommentViewer;
    attachmentId: string;
  }): Promise<Result<string, CommentErrorCode>> {
    return attachmentDownloadUrl(input);
  },

  async resolveCommentThreadById(
    input: {
      viewer: CommentViewer;
      threadId: string;
    },
    recordWrite?: RecordComment
  ): ThreadResult {
    const located = await locateThread(input);
    if (!located.ok) {
      return located;
    }
    const { liveState, present } = actorOn(input.viewer, located.value.target);
    return resolveCommentThread(
      {
        ...input,
        located: located.value,
        liveState,
        present,
      },
      recordWrite
    );
  },

  async reopenCommentThreadById(
    input: {
      viewer: CommentViewer;
      threadId: string;
    },
    recordWrite?: RecordComment
  ): ThreadResult {
    const located = await locateThread(input);
    if (!located.ok) {
      return located;
    }
    const { liveState, present } = actorOn(input.viewer, located.value.target);
    return reopenCommentThread(
      {
        ...input,
        located: located.value,
        liveState,
        present,
      },
      recordWrite
    );
  },

  async retryCommentThreadSync(
    input: {
      viewer: CommentViewer;
      threadId: string;
    },
    recordWrite?: RecordComment
  ): ThreadResult {
    const located = await locateThread(input);
    if (!located.ok) {
      return located;
    }
    return retrySync(
      {
        ...actorOn(input.viewer, located.value.target),
        comment: { threadId: input.threadId },
      },
      recordWrite
    );
  },
};

/** The viewer acting on a resolved target, with one live state for the request. */
function actorOn(viewer: CommentViewer, target: CommentTarget) {
  const liveState = createCommentLiveState(viewer);
  return {
    viewer,
    target,
    liveState,
    present: presentCommentThreadDto({ viewer, target, liveState }),
  };
}

async function locateThread(input: {
  viewer: CommentViewer;
  threadId: string;
}): Promise<Result<SourcedCommentTarget, CommentErrorCode>> {
  const located = await resolveThreadCommentTarget({
    organizationId: input.viewer.organizationId,
    threadId: input.threadId,
  });
  if (!located.ok) {
    return located;
  }
  const writable = await writableOnly(Result.ok(located.value.target));
  return writable.ok ? located : writable;
}

async function locateComment(input: {
  viewer: CommentViewer;
  commentId: string;
}): Promise<Result<CommentTarget, CommentErrorCode>> {
  const located = await resolveCommentIdTarget({
    organizationId: input.viewer.organizationId,
    commentId: input.commentId,
  });
  return writableOnly(located.ok ? Result.ok(located.value.target) : located);
}

/** The comment an attachment hangs on, located as a comment-id route locates it. */
async function locateAttachment(input: {
  viewer: CommentViewer;
  attachmentId: string;
}): Promise<Result<CommentTarget, CommentErrorCode>> {
  const owner = await withDb((db) =>
    db.commentAttachment.findFirst({
      where: {
        id: input.attachmentId,
        comment: { thread: { organizationId: input.viewer.organizationId } },
      },
      select: { commentId: true },
    })
  );
  return owner
    ? locateComment({ viewer: input.viewer, commentId: owner.commentId })
    : Result.err(CommentErrorCode.NotFound);
}

/**
 * A Branch the product no longer serves answers not_found to every write, as
 * its read does and the legacy branch routes do (PLN-2121 pipeline step 1).
 */
async function servedOnly(
  resolved: Result<CommentTarget, CommentErrorCode>
): Promise<Result<CommentTarget, CommentErrorCode>> {
  if (
    !resolved.ok ||
    resolved.value.artifactType !== CommentArtifactType.Branch
  ) {
    return resolved;
  }
  const { organizationId, artifactId } = resolved.value;
  const served = await withDb((db) =>
    branchHasCloudEligibility(db, organizationId, artifactId)
  );
  return served ? resolved : Result.err(CommentErrorCode.NotFound);
}

/**
 * Every request here that locates a target writes to it. A write must be on a
 * target the product serves, and a Document only once its org has switched to
 * unified document comments (PLN-2187 T-2.6); until then it answers
 * `artifact_type_not_supported`, as it did before Documents resolved. Reads
 * are not gated.
 */
async function writableOnly(
  resolved: Result<CommentTarget, CommentErrorCode>
): Promise<Result<CommentTarget, CommentErrorCode>> {
  const served = await servedOnly(resolved);
  if (
    !served.ok ||
    served.value.artifactType !== CommentArtifactType.Document ||
    (await resolveAndLatchDocumentCommentsSwitch(served.value.organizationId))
  ) {
    return served;
  }
  return Result.err(CommentErrorCode.ArtifactTypeNotSupported);
}

type ReactionRequest = {
  viewer: CommentViewer;
  commentId: string;
  emoji: CommentReactionEmoji;
};

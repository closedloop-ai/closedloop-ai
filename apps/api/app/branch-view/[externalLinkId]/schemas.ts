import {
  BranchViewCommentAction,
  GitHubDiffSide,
} from "@repo/api/src/types/branch-view";
import { z } from "zod";

// Backend-only request validators for branch-view comment mutation routes.
const bodySchema = z.string().trim().min(1);
/** Maximum raw JSON request size accepted by branch-view comment actions. */
export const BRANCH_VIEW_COMMENT_REQUEST_MAX_BYTES = 128 * 1024;
/** Maximum markdown body length accepted before a GitHub comment write. */
export const BRANCH_VIEW_COMMENT_BODY_MAX_LENGTH = 65_536;
/** Maximum repository path length accepted for inline comment anchors. */
export const BRANCH_VIEW_COMMENT_PATH_MAX_LENGTH = 4096;
const diffSideSchema = z.enum(GitHubDiffSide);

export const createBranchViewConversationCommentRequestSchema = z.strictObject({
  body: bodySchema.max(BRANCH_VIEW_COMMENT_BODY_MAX_LENGTH),
});

export const createBranchViewInlineCommentRequestSchema = z
  .strictObject({
    body: bodySchema.max(BRANCH_VIEW_COMMENT_BODY_MAX_LENGTH),
    path: z.string().min(1).max(BRANCH_VIEW_COMMENT_PATH_MAX_LENGTH),
    line: z.number().int().positive(),
    side: diffSideSchema,
    expectedHeadSha: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    startSide: diffSideSchema.optional(),
  })
  .superRefine((request, ctx) => {
    const hasStartLine = request.startLine !== undefined;
    const hasStartSide = request.startSide !== undefined;

    if (hasStartLine === hasStartSide) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "startLine and startSide must be provided together",
      path: hasStartLine ? ["startSide"] : ["startLine"],
    });
  });

export const replyToBranchViewCommentRequestSchema = z.strictObject({
  commentGithubId: z.number().int().positive(),
  body: bodySchema.max(BRANCH_VIEW_COMMENT_BODY_MAX_LENGTH),
});

export const updateBranchViewCommentRequestSchema = z.strictObject({
  body: bodySchema.max(BRANCH_VIEW_COMMENT_BODY_MAX_LENGTH),
});

export const deleteBranchViewCommentRequestSchema = z.strictObject({});

export const resolveBranchViewCommentRequestSchema = z.strictObject({});

export const unresolveBranchViewCommentRequestSchema = z.strictObject({});

export const BRANCH_VIEW_COMMENT_REQUEST_SCHEMAS_BY_ACTION = {
  [BranchViewCommentAction.CreateConversation]:
    createBranchViewConversationCommentRequestSchema,
  [BranchViewCommentAction.CreateInline]:
    createBranchViewInlineCommentRequestSchema,
  [BranchViewCommentAction.Reply]: replyToBranchViewCommentRequestSchema,
  [BranchViewCommentAction.Edit]: updateBranchViewCommentRequestSchema,
  [BranchViewCommentAction.Delete]: deleteBranchViewCommentRequestSchema,
  [BranchViewCommentAction.Resolve]: resolveBranchViewCommentRequestSchema,
  [BranchViewCommentAction.Unresolve]: unresolveBranchViewCommentRequestSchema,
} as const;

import {
  BranchCommentsBudget,
  BranchCommentsFailureReason,
  BranchCommentsState,
  BranchPrCommentKind,
  type BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import { z } from "zod";
import { LivePrOverlayError } from "./live-pr-overlay-error";
import type { PrIdentity } from "./pr-identity";

export type LivePrCommentsIdentity = PrIdentity & {
  branchId: string;
};

const commentsEnvelopeSchema = z.object({
  branchId: z.string(),
  state: z.enum(BranchCommentsState),
  failureReason: z.enum(BranchCommentsFailureReason).optional(),
  comments: z.array(
    z.object({
      id: z.string(),
      providerNodeId: z.string().nullable(),
      providerCommentId: z.string().nullable(),
      kind: z.enum(BranchPrCommentKind),
      threadId: z.string().nullable(),
      inReplyToId: z.string().nullable(),
      path: z.string().nullable(),
      line: z.number().nullable(),
      resolved: z.boolean().nullable(),
      author: z.object({
        login: z.string(),
        displayName: z.string().nullable(),
        avatarUrl: z.string().nullable(),
        profileUrl: z.string().nullable(),
      }),
      body: z.string(),
      createdAt: z.string(),
      updatedAt: z.string().nullable(),
      providerUrl: z.string().nullable(),
      stale: z.boolean(),
      bodyTruncated: z.boolean(),
    })
  ),
  budget: z.object({
    maxComments: z.number(),
    pageSize: z.number(),
    maxBodyBytes: z.number(),
    maxResponseBytes: z.number(),
    providerTruncated: z.boolean(),
    responseTruncated: z.boolean(),
    omittedComments: z.number(),
    bodyTruncatedCount: z.number(),
  }),
  providerProofedAt: z.string().nullable(),
  stale: z.boolean(),
  mixedProjection: z.boolean(),
  prNumber: z.number().nullable(),
  prUrl: z.string().nullable(),
});

const errorEnvelopeSchema = z
  .object({
    error: z.string(),
    reason: z.enum(BranchCommentsFailureReason).optional(),
  })
  .partial();

export async function fetchLivePrComments(
  identity: LivePrCommentsIdentity | null
): Promise<BranchPrCommentsResponse> {
  if (!identity) {
    return buildLocalCommentsResponse({
      branchId: "",
      state: BranchCommentsState.UnsyncedUnknown,
      prNumber: null,
      prUrl: null,
    });
  }
  const params = new URLSearchParams({
    owner: identity.owner,
    repo: identity.repo,
    number: String(identity.prNumber),
    branchId: identity.branchId,
  });
  const response = await fetch(
    `/api/gateway/git/pr/comments?${params.toString()}`
  );
  if (!response.ok) {
    const errorEnvelope = await readErrorEnvelope(response);
    if (
      errorEnvelope.reason === BranchCommentsFailureReason.ForbiddenMismatch
    ) {
      return buildLocalCommentsResponse({
        branchId: identity.branchId,
        state: BranchCommentsState.ForbiddenMismatch,
        prNumber: identity.prNumber,
        prUrl: null,
      });
    }
    if (errorEnvelope.reason) {
      return buildLocalCommentsResponse({
        branchId: identity.branchId,
        state: BranchCommentsState.ProviderError,
        prNumber: identity.prNumber,
        prUrl: null,
        failureReason: errorEnvelope.reason,
      });
    }
    throw new LivePrOverlayError(errorEnvelope.error, {
      code: errorEnvelope.error,
      status: response.status,
    });
  }
  return commentsEnvelopeSchema.parse(await response.json());
}

export function buildLocalCommentsResponse({
  branchId,
  state,
  prNumber,
  prUrl,
  failureReason,
}: {
  branchId: string;
  state: BranchCommentsState;
  prNumber: number | null;
  prUrl: string | null;
  failureReason?: BranchCommentsFailureReason;
}): BranchPrCommentsResponse {
  const response: BranchPrCommentsResponse = {
    branchId,
    state,
    comments: [],
    budget: {
      maxComments: BranchCommentsBudget.MaxComments,
      pageSize: BranchCommentsBudget.PageSize,
      maxBodyBytes: BranchCommentsBudget.MaxBodyBytes,
      maxResponseBytes: BranchCommentsBudget.MaxResponseBytes,
      providerTruncated: false,
      responseTruncated: false,
      omittedComments: 0,
      bodyTruncatedCount: 0,
    },
    providerProofedAt: null,
    stale: false,
    mixedProjection: false,
    prNumber,
    prUrl,
  };
  if (failureReason) {
    response.failureReason = failureReason;
  }
  return response;
}

async function readErrorEnvelope(
  response: Response
): Promise<{ error: string; reason?: BranchCommentsFailureReason }> {
  try {
    const parsed = errorEnvelopeSchema.safeParse(await response.json());
    if (parsed.success && parsed.data.error) {
      const envelope: { error: string; reason?: BranchCommentsFailureReason } =
        {
          error: parsed.data.error,
        };
      if (parsed.data.reason) {
        envelope.reason = parsed.data.reason;
      }
      return envelope;
    }
  } catch {
    // Non-JSON error body falls through to the synthetic code.
  }
  return { error: `pr-comments-${response.status}` };
}

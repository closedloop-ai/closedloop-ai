"use client";

import {
  type BranchViewCommentIdentityBlocker,
  BranchViewCommentWriteIdentityStatus,
} from "@repo/api/src/types/branch-view";
import { z } from "zod";
import { ApiError } from "../../shared/api/api-error";
import { toastMutationError } from "../../shared/query/query-client";

/**
 * Field validators for the identity blocker, kept as a standalone literal so
 * the keys-covered guard below can see them.
 *
 * `satisfies Record<keyof BranchViewCommentIdentityBlocker, z.ZodTypeAny>` makes
 * the shape total over the contract: adding a field to
 * {@link BranchViewCommentIdentityBlocker} without teaching it here fails `tsc`
 * rather than silently degrading the prompt at runtime (the FEA-3701 class of
 * drift recorded in the root AGENTS.md).
 *
 * Scope: this proves KEY COVERAGE only. `z.ZodTypeAny` is the top type, so it
 * does NOT pin a key's bounds or its optionality. It is also compile-time only:
 * a server that adds a field to `identityBlocker` still fails this `.strict()`
 * parse at runtime, which returns null and falls back to the generic toast.
 */
const branchViewCommentIdentityBlockerShape = {
  status: z.enum([
    BranchViewCommentWriteIdentityStatus.Missing,
    BranchViewCommentWriteIdentityStatus.Expired,
    BranchViewCommentWriteIdentityStatus.Revoked,
    BranchViewCommentWriteIdentityStatus.DecryptionFailed,
  ]),
} satisfies Record<keyof BranchViewCommentIdentityBlocker, z.ZodTypeAny>;

const branchViewCommentIdentityBlockerSchema = z
  .object(branchViewCommentIdentityBlockerShape)
  .strict();

/**
 * Mutation `onError` for Branch View comment actions: identity-blocker errors
 * are rendered by the local connect/reconnect prompt UI, so they are
 * swallowed here; every other error falls back to the standard error toast.
 * Assign to a comment mutation's `onError` — it replaces the query client's
 * generic default (FEA-1510).
 */
export function branchViewCommentOnError(error: unknown): void {
  if (!isBranchViewIdentityBlockerError(error)) {
    toastMutationError(error);
  }
}

/** Extract the exact token-free identity blocker from an API mutation error. */
export function parseBranchViewCommentIdentityBlocker(
  error: unknown
): BranchViewCommentIdentityBlocker | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  const parsed = branchViewCommentIdentityBlockerSchema.safeParse(
    error.details?.identityBlocker
  );
  return parsed.success ? parsed.data : null;
}

/** Return whether an error can be handled by Branch View identity prompt UI. */
export function isBranchViewIdentityBlockerError(error: unknown): boolean {
  return parseBranchViewCommentIdentityBlocker(error) !== null;
}

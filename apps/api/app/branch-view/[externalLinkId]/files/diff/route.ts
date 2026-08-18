import {
  type BranchViewFileDiff,
  BranchViewFileDiffErrorCode,
} from "@repo/api/src/types/branch-view";
import { failure } from "@repo/api/src/types/common";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import type { GitHubAccessError } from "@/lib/github/github-access";
import {
  BranchViewContextCredentialMode,
  resolvePrContext,
} from "@/lib/resolve-pr-context";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { getFileDiff } from "./service";

export const GET = withAnyAuth<
  BranchViewFileDiff,
  "/branch-view/[externalLinkId]/files/diff"
>(async ({ user }, request, params) => {
  try {
    const { externalLinkId } = await params;
    const path = request.nextUrl.searchParams.get("path");
    const previousPath = request.nextUrl.searchParams.get("previousPath");

    if (!path) {
      return badRequestResponse("path query parameter is required");
    }

    const ctx = await resolvePrContext(externalLinkId, user.organizationId, {
      credentialMode: BranchViewContextCredentialMode.RenderRead,
    });
    if (!ctx) {
      return notFoundResponse("Branch view");
    }

    const result = await getFileDiff(ctx, user.id, path, previousPath || null);
    if (result.accessDenial) {
      return fileDiffAccessDenialResponse(result.accessDenial);
    }
    if (result.error || !result.data) {
      return notFoundResponse(result.error ?? "File diff unavailable");
    }

    return successResponse(result.data);
  } catch (error) {
    return errorResponse("Failed to fetch file diff", error);
  }
});

/**
 * Translate a GitHub read denial into the right HTTP failure.
 *
 * Only a genuine authorization denial may answer 403 here: `useBranchViewFileDiff`
 * opts out of the shell-wide re-auth boundary (load-bearing for 401 since
 * ISS-5095 stopped a bare 403 latching at all) precisely because a 401/403 on
 * this route means "no access to this Branch View" (FEA-3940). A rate limit or a
 * GitHub outage is transient and must not be filed under that meaning — it would
 * read as a permanent authorization failure and could never be retried.
 *
 * Rate limits carry the resolver's ETA through as `Retry-After`, matching the
 * sibling `sync` route's 429 contract. The `github_access_denied` code stays on
 * every branch so one client-side parser handles them all; the status is what
 * separates "you cannot" from "not right now".
 */
function fileDiffAccessDenialResponse(denial: GitHubAccessError) {
  const details = { accessDenial: denial.reason };
  if (denial.reason === GitHubAccessDenialReason.RateLimited) {
    return NextResponse.json(
      failure("GitHub rate limit reached", {
        code: BranchViewFileDiffErrorCode.GithubAccessDenied,
        details: denial.retryAfterSeconds
          ? { ...details, retryAfterSeconds: denial.retryAfterSeconds }
          : details,
      }),
      {
        status: 429,
        ...(denial.retryAfterSeconds
          ? { headers: { "Retry-After": String(denial.retryAfterSeconds) } }
          : {}),
      }
    );
  }
  if (
    denial.reason === GitHubAccessDenialReason.Unavailable ||
    denial.reason === GitHubAccessDenialReason.BudgetDeferred
  ) {
    return NextResponse.json(
      failure("GitHub is unavailable", {
        code: BranchViewFileDiffErrorCode.GithubAccessDenied,
        details,
      }),
      { status: 503 }
    );
  }
  // A reachability denial is not a missing file: the diff exists, this user's
  // GitHub credential just cannot read it. The reason lets the client offer the
  // matching remediation (connect, reconnect, request access).
  return forbiddenResponse({
    code: BranchViewFileDiffErrorCode.GithubAccessDenied,
    details,
  });
}

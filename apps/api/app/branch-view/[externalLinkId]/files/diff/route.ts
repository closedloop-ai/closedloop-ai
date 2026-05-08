import type { BranchViewFileDiff } from "@repo/api/src/types/branch-view";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolvePrContext } from "@/lib/resolve-pr-context";
import {
  badRequestResponse,
  errorResponse,
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

    const ctx = await resolvePrContext(externalLinkId, user.organizationId);
    if (!ctx) {
      return notFoundResponse("Branch view");
    }

    const result = await getFileDiff(ctx, path, previousPath || null);
    if (result.error || !result.data) {
      return notFoundResponse(result.error ?? "File diff unavailable");
    }

    return successResponse(result.data);
  } catch (error) {
    return errorResponse("Failed to fetch file diff", error);
  }
});

import type { CommentThreadWithComments } from "@repo/api/src/types/comment";
import { ThreadStatus } from "@repo/api/src/types/comment";
import { success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { errorResponse, notFoundResponse, parseBody } from "@/lib/route-utils";
import { commentsService } from "../../../comments/service";
import { documentsService } from "../../service";

const getThreadsValidator = z.object({
  status: z.enum(ThreadStatus).optional(),
});

const createThreadValidator = z.object({
  body: z.string().min(1),
  anchorText: z.string().min(1),
});

export const POST = withAnyAuth<
  { commentId: string; threadId: string },
  "/documents/[id]/threads"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;

    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const artifact = await documentsService.findById(
      resolvedId,
      user.organizationId
    );
    if (!artifact) {
      return notFoundResponse("Artifact");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      createThreadValidator
    );
    if (parseError) {
      return parseError;
    }

    const result = await commentsService.createDocumentThread(
      user.organizationId,
      artifact.slug,
      user.id,
      body.body,
      body.anchorText
    );

    return NextResponse.json(success(result));
  } catch (error) {
    const status =
      error != null &&
      typeof error === "object" &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : 500;

    return errorResponse("Failed to create thread", error, status);
  }
});

export const GET = withAnyAuth<
  CommentThreadWithComments[],
  "/documents/[id]/threads"
>(async ({ user }, request, params) => {
  const { id } = await params;

  const resolvedId = await resolveDocumentId(id, user.organizationId);
  if (!resolvedId) {
    return notFoundResponse("Artifact");
  }

  const result = getThreadsValidator.safeParse(
    Object.fromEntries(request.nextUrl.searchParams)
  );
  if (!result.success) {
    return errorResponse("Invalid query params", result.error, 400);
  }

  const threads = await commentsService.findThreadsByDocument(
    user.organizationId,
    resolvedId,
    { status: result.data.status }
  );

  return NextResponse.json(success(threads));
});

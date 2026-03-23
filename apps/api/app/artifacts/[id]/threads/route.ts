import { success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveArtifactId } from "@/lib/identifier-utils";
import { errorResponse, notFoundResponse, parseBody } from "@/lib/route-utils";
import { commentsService } from "../../../comments/service";
import { artifactsService } from "../../service";

const createThreadValidator = z.object({
  body: z.string().min(1),
});

export const POST = withAnyAuth<
  { commentId: string; threadId: string },
  "/artifacts/[id]/threads"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;

    const resolvedId = await resolveArtifactId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const artifact = await artifactsService.findById(
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

    const result = await commentsService.createAndPersistArtifactThread(
      user.organizationId,
      artifact.slug,
      user.id,
      body.body
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

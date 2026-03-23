import { success } from "@repo/api/src/types/common";
import { createArtifactThread } from "@repo/collaboration/room-management";
import { generateArtifactRoomId } from "@repo/collaboration/room-utils";
import type { ThreadData } from "@repo/collaboration/webhook";
import { log } from "@repo/observability/log";
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

    const roomId = generateArtifactRoomId(user.organizationId, artifact.slug);

    let threadData: ThreadData;
    try {
      threadData = await createArtifactThread({
        roomId,
        userId: user.id,
        bodyText: body.body,
      });
    } catch (liveblocksError) {
      const message =
        liveblocksError instanceof Error
          ? liveblocksError.message
          : String(liveblocksError);

      if (message.includes("not configured")) {
        return errorResponse(
          "Liveblocks is not configured",
          liveblocksError,
          503
        );
      }

      if (
        message.toLowerCase().includes("not found") ||
        message.toLowerCase().includes("does not exist")
      ) {
        return errorResponse("Liveblocks room not found", liveblocksError, 404);
      }

      return errorResponse("Failed to create thread", liveblocksError, 503);
    }

    try {
      await commentsService.upsertThreadFromLiveblocks(
        user.organizationId,
        threadData
      );
      await commentsService.upsertCommentFromLiveblocks(
        user.organizationId,
        threadData.id,
        threadData.comments[0]
      );
    } catch (dbError) {
      log.error("Best-effort DB sync failed after thread creation", {
        error: dbError instanceof Error ? dbError.message : String(dbError),
        threadId: threadData.id,
      });
    }

    return NextResponse.json(
      success({
        commentId: threadData.comments[0].id,
        threadId: threadData.id,
      })
    );
  } catch (error) {
    return errorResponse("Failed to create thread", error);
  }
});

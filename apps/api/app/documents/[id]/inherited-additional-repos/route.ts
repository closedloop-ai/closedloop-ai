import { LoopCommandSchema } from "@closedloop-ai/loops-api/commands";
import { success } from "@repo/api/src/types/common";
import type { InheritedAdditionalRepos } from "@repo/api/src/types/loop";
import { NextResponse } from "next/server";
import { loopsService } from "@/app/loops/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
} from "@/lib/route-utils";

/**
 * Return the peer-repo set the UI should pre-fill when the user is about to
 * launch `?command=<LoopCommand>` against this document. The precedence
 * chain is dispatched per target command in
 * `loopsService.findInheritedAdditionalRepos`.
 *
 * The frontend gets a tiny payload (`{ additionalRepos, source }`) instead
 * of streaming loop pages over the wire to filter client-side.
 */
export const GET = withAnyAuth<
  InheritedAdditionalRepos,
  "/documents/[id]/inherited-additional-repos"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    const documentId = await resolveDocumentId(id, user.organizationId);
    if (!documentId) {
      return notFoundResponse("Document");
    }

    const rawCommand = new URL(request.url).searchParams.get("command");
    const parsedCommand = LoopCommandSchema.safeParse(rawCommand);
    if (!parsedCommand.success) {
      return badRequestResponse(
        "`command` query parameter is required and must be a LoopCommand value."
      );
    }

    const result = await loopsService.findInheritedAdditionalRepos(
      documentId,
      user.organizationId,
      parsedCommand.data
    );

    return NextResponse.json(success(result));
  } catch (error) {
    return errorResponse("Failed to resolve inherited additional repos", error);
  }
});

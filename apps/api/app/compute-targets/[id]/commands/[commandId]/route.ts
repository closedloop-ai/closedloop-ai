import type { DesktopCommandSummary } from "@repo/api/src/types/compute-target";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { computeTargetsService } from "../../../service";

/**
 * GET /compute-targets/:id/commands/:commandId
 * Returns command lifecycle status and summary metadata.
 */
export const GET = withAnyAuth<
  DesktopCommandSummary,
  "/compute-targets/[id]/commands/[commandId]"
>(async ({ user }, _request, params) => {
  try {
    const { id: targetId, commandId } = await params;
    const target = await computeTargetsService.findOwnedById(
      targetId,
      user.organizationId,
      user.id
    );
    if (!target) {
      return forbiddenResponse();
    }

    const command = await desktopCommandStore.getCommand(target.id, commandId);
    if (!command) {
      return notFoundResponse("Desktop command");
    }

    return successResponse(command);
  } catch (error) {
    return errorResponse("Failed to fetch desktop command", error);
  }
});

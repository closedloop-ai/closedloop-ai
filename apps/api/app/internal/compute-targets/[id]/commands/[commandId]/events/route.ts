import { BranchViewLocalErrorCode } from "@repo/api/src/types/branch-view-local";
import { failure } from "@repo/api/src/types/common";
import { isStoredBranchViewLocalCommand } from "@/lib/branch-view-local-authorization";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { validateInternalSecret } from "@/lib/internal-auth";
import {
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; commandId: string }> }
): Promise<Response> {
  if (!validateInternalSecret(request)) {
    return unauthorizedResponse();
  }

  const { id: targetId, commandId } = await params;
  const command = await desktopCommandStore.getCommand(targetId, commandId);
  if (!command) {
    return notFoundResponse("Desktop command");
  }

  const isLocalContent = await isStoredBranchViewLocalCommand({
    commandId,
    computeTargetId: targetId,
  });
  if (isLocalContent) {
    return Response.json(
      failure(BranchViewLocalErrorCode.PublicEventReadRequired, {
        code: BranchViewLocalErrorCode.PublicEventReadRequired,
      }),
      { status: 403 }
    );
  }

  const url = new URL(request.url);
  const afterSequenceParam = url.searchParams.get("afterSequence");
  const afterSequenceRaw =
    afterSequenceParam === null ? Number.NaN : Number(afterSequenceParam);
  const afterSequence =
    Number.isInteger(afterSequenceRaw) && afterSequenceRaw >= 0
      ? afterSequenceRaw
      : undefined;

  const events = await desktopCommandStore.getCommandEvents(
    targetId,
    commandId,
    { afterSequence }
  );
  return successResponse(events ?? []);
}

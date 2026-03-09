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

  const events = await desktopCommandStore.getCommandEvents(
    targetId,
    commandId
  );
  return successResponse(events ?? []);
}

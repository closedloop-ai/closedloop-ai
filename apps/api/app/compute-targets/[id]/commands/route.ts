import type {
  CreateDesktopCommandInput,
  CreateDesktopCommandResponse,
} from "@repo/api/src/types/compute-target";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { toRelayOperation } from "../../relay-command-helpers";
import { computeTargetsService } from "../../service";
import { createDesktopCommandValidator } from "../../validators";

/**
 * POST /compute-targets/:id/commands
 * Queues a desktop command and attempts immediate dispatch to active target transport.
 */
export const POST = withAnyAuth<
  CreateDesktopCommandResponse,
  "/compute-targets/[id]/commands"
>(async ({ user }, request, params) => {
  try {
    const { id: targetId } = await params;
    const { body, errorResponse: parseError } = await parseBody(
      request,
      createDesktopCommandValidator
    );
    if (parseError || !body) {
      return parseError;
    }

    const target = await computeTargetsService.findOwnedById(
      targetId,
      user.organizationId,
      user.id
    );
    if (!target) {
      return notFoundResponse("Compute target");
    }

    const input = body as CreateDesktopCommandInput;
    const createResult = await desktopCommandStore.createCommand(
      target.id,
      input
    );

    const relayOperation = toRelayOperation(
      createResult.command.commandId,
      input
    );
    relayEventBus.publishOperation(target.id, relayOperation);

    return successResponse({
      commandId: createResult.command.commandId,
      status: createResult.command.status,
      deduped: createResult.deduped ? true : undefined,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === desktopCommandStore.IdempotencyConflictError.name
    ) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 409 }
      );
    }
    return errorResponse("Failed to create desktop command", error);
  }
});

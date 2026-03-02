import { failure } from "@repo/api/src/types/common";
import type { RelayOperationDispatchRequest } from "@repo/api/src/types/compute-target";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { relayEventBus } from "@/lib/relay-event-bus";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { computeTargetsService } from "../../service";
import { relayOperationDispatchValidator } from "../../validators";

type DispatchOperationResponse = {
  queued: true;
  deliveredToSubscriber: boolean;
};

/**
 * POST /compute-targets/:id/operations
 * Dispatches an operation to a connected compute target.
 */
export const POST = withAnyAuth<
  DispatchOperationResponse,
  "/compute-targets/[id]/operations"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    const { body, errorResponse: parseError } = await parseBody(
      request,
      relayOperationDispatchValidator
    );
    if (parseError || !body) {
      return parseError;
    }

    await computeTargetsService.markStaleTargetsOffline({
      organizationId: user.organizationId,
      userId: user.id,
    });

    const target = await computeTargetsService.findOwnedById(
      id,
      user.organizationId,
      user.id
    );
    if (!target?.isOnline) {
      return NextResponse.json(failure("Compute target offline"), {
        status: 503,
      });
    }

    const operation = body as RelayOperationDispatchRequest;
    const createResult = await desktopCommandStore.createFromRelayOperation(
      target.id,
      operation
    );
    const operationWithCommandId: RelayOperationDispatchRequest = {
      ...operation,
      params:
        operation.params && typeof operation.params === "object"
          ? ({
              ...(operation.params as Record<string, unknown>),
              commandId: createResult.command.commandId,
            } as RelayOperationDispatchRequest["params"])
          : ({
              commandId: createResult.command.commandId,
            } as RelayOperationDispatchRequest["params"]),
    };
    const result = relayEventBus.publishOperation(
      target.id,
      operationWithCommandId
    );

    return successResponse({
      queued: true,
      deliveredToSubscriber: result.deliveredToSubscriber,
    });
  } catch (error) {
    return errorResponse("Failed to dispatch operation", error);
  }
});

import type {
  CreateDesktopCommandInput,
  CreateDesktopCommandResponse,
  RelayOperationDispatchRequest,
} from "@repo/api/src/types/compute-target";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { computeTargetsService } from "../../service";
import { createDesktopCommandValidator } from "../../validators";

function appendQuery(
  path: string,
  query?: Record<string, string | string[]>
): string {
  if (!query || Object.keys(query).length === 0) {
    return path;
  }

  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    if (Array.isArray(raw)) {
      for (const value of raw) {
        params.append(key, value);
      }
      continue;
    }
    params.set(key, raw);
  }
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function toRelayOperation(
  commandId: string,
  input: CreateDesktopCommandInput
): RelayOperationDispatchRequest {
  return {
    operationId: input.operationId,
    operation: "engineer_http_request",
    params: {
      request: {
        method: input.method,
        path: appendQuery(input.path, input.query),
        headers: input.headers ?? {},
        body: input.body ?? null,
      },
      commandId,
      lockKey: input.lockKey ?? null,
      timeoutMs: input.timeoutMs ?? null,
      requiresApproval: input.requiresApproval ?? null,
      approvalReason: input.approvalReason ?? null,
    },
    streaming: input.streaming ?? false,
  };
}

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

    await computeTargetsService.markStaleTargetsOffline({
      organizationId: user.organizationId,
      userId: user.id,
    });

    const target = await computeTargetsService.findOwnedById(
      targetId,
      user.organizationId,
      user.id
    );
    if (!target) {
      return forbiddenResponse();
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

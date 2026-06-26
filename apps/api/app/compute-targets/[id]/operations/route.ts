import { BranchViewLocalHeader } from "@repo/api/src/types/branch-view-local";
import { failure } from "@repo/api/src/types/common";
import type { RelayOperationDispatchRequest } from "@repo/api/src/types/compute-target";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  classifyBranchViewLocalCommand,
  validateBranchViewLocalAccess,
} from "@/lib/branch-view-local-authorization";
import {
  browserKeyRevocationReservedResponse,
  isReservedBrowserKeyRevocationRelayOperation,
} from "@/lib/browser-key-revocation-command";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { relayEventBus } from "@/lib/relay-event-bus";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { isRecord } from "@/lib/type-guards";
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

    const operation = body as RelayOperationDispatchRequest;
    if (isReservedBrowserKeyRevocationRelayOperation(operation)) {
      return browserKeyRevocationReservedResponse();
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

    let operationForDispatch = operation;
    if (classifyBranchViewLocalCommand(operation)) {
      const params = isRecord(operation.params) ? operation.params : {};
      const requestPayload = isRecord(params.request) ? params.request : {};
      const headers = isRecord(requestPayload.headers)
        ? Object.fromEntries(
            Object.entries(requestPayload.headers).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          )
        : {};
      const proof = await validateBranchViewLocalAccess({
        userId: user.id,
        organizationId: user.organizationId,
        computeTargetId: target.id,
        externalLinkId: headers[BranchViewLocalHeader.ExternalLinkId] ?? "",
        repoFullName: headers[BranchViewLocalHeader.RepoFullName] ?? "",
        headBranch: headers[BranchViewLocalHeader.HeadBranch] ?? "",
        prNumber: Number(headers[BranchViewLocalHeader.PrNumber]),
        operationPath:
          typeof requestPayload.path === "string" ? requestPayload.path : "",
      });
      if (!proof.ok) {
        return NextResponse.json(failure(proof.error, { code: proof.code }), {
          status: proof.status,
        });
      }
      operationForDispatch = {
        ...operation,
        params: {
          ...params,
          request: {
            ...requestPayload,
            headers: {
              ...headers,
              ...proof.metadataHeaders,
            },
          },
        } as RelayOperationDispatchRequest["params"],
      };
    }

    const createResult = await desktopCommandStore.createFromRelayOperation(
      target.id,
      operationForDispatch
    );
    const operationWithCommandId: RelayOperationDispatchRequest = {
      ...operationForDispatch,
      params: isRecord(operationForDispatch.params)
        ? ({
            ...operationForDispatch.params,
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

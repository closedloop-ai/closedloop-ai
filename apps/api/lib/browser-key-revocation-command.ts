import { isDesktopApiPath } from "@repo/api/src/desktop-api-namespace";
import {
  type ApiResult,
  failure,
  type JsonValue,
} from "@repo/api/src/types/common";
import type {
  BrowserKeyApprovalRequestCommandBody,
  BrowserKeyRevocationCommandBody,
  CreateDesktopCommandInput,
  RelayOperationDispatchRequest,
} from "@repo/api/src/types/compute-target";
import {
  BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID,
  BROWSER_KEY_APPROVAL_REQUEST_PATH,
  BROWSER_KEY_REVOCATION_OPERATION_ID,
  BROWSER_KEY_REVOCATION_PATH,
  BROWSER_KEY_REVOCATION_RESERVED_ERROR_CODE,
} from "@repo/api/src/types/compute-target";
import { NextResponse } from "next/server";
import { parseJsonObject } from "@/lib/json-schema";

type BrowserKeyCommandInput = {
  publicKeyId: string;
  userId: string;
  fingerprint: string;
  computeTargetId?: string;
  gatewayId?: string | null;
};

const RESERVED_BROWSER_KEY_OPERATION_IDS = new Set<string>([
  BROWSER_KEY_REVOCATION_OPERATION_ID,
  BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID,
]);

const RESERVED_BROWSER_KEY_PATHS = new Set<string>([
  BROWSER_KEY_REVOCATION_PATH,
  BROWSER_KEY_APPROVAL_REQUEST_PATH,
]);

function toPathname(path: string): string {
  try {
    return new URL(path, "http://desktop.local").pathname;
  } catch {
    return path.split("?")[0] ?? path;
  }
}

/**
 * Matches reserved browser-key internal paths in the current Desktop API
 * namespace. Public command entry points must reject these paths.
 */
export function isReservedBrowserKeyRevocationPath(path: string): boolean {
  const pathname = toPathname(path);
  return isDesktopApiPath(pathname) && RESERVED_BROWSER_KEY_PATHS.has(pathname);
}

/**
 * Returns true when a public desktop command input attempts to use the
 * internal browser-key operation id or path.
 */
export function isReservedBrowserKeyRevocationCommand(
  input: Pick<CreateDesktopCommandInput, "operationId" | "path">
): boolean {
  return (
    RESERVED_BROWSER_KEY_OPERATION_IDS.has(input.operationId) ||
    isReservedBrowserKeyRevocationPath(input.path)
  );
}

/**
 * Returns true when a public relay operation attempts to dispatch the internal
 * browser-key operation id or request path.
 */
export function isReservedBrowserKeyRevocationRelayOperation(
  operation: RelayOperationDispatchRequest
): boolean {
  if (
    RESERVED_BROWSER_KEY_OPERATION_IDS.has(operation.operationId) ||
    RESERVED_BROWSER_KEY_OPERATION_IDS.has(operation.operation)
  ) {
    return true;
  }

  const params = parseJsonObject(operation.params);
  const request = params ? parseJsonObject(params.request) : null;
  return (
    typeof request?.path === "string" &&
    isReservedBrowserKeyRevocationPath(request.path)
  );
}

/**
 * Shared response for public callers that attempt to dispatch the reserved
 * browser-key internal commands directly.
 */
export function browserKeyRevocationReservedResponse(): NextResponse<
  ApiResult<never>
> {
  return NextResponse.json(
    failure("Browser key internal commands are internal", {
      code: BROWSER_KEY_REVOCATION_RESERVED_ERROR_CODE,
    }),
    { status: 403 }
  );
}

function toBrowserKeyCommandBody(input: {
  publicKeyId: string;
  userId: string;
  fingerprint: string;
  computeTargetId?: string;
  gatewayId?: string | null;
}) {
  const body:
    | BrowserKeyRevocationCommandBody
    | BrowserKeyApprovalRequestCommandBody = {
    publicKeyId: input.publicKeyId,
    userId: input.userId,
    fingerprint: input.fingerprint,
  };

  if (input.computeTargetId) {
    body.computeTargetId = input.computeTargetId;
  }
  if (input.gatewayId) {
    body.gatewayId = input.gatewayId;
  }

  return body;
}

/**
 * Builds the internal Desktop command that asks an online target to
 * remove a previously registered browser command-signing key.
 */
export function buildBrowserKeyRevocationCommandInput(
  input: BrowserKeyCommandInput
): CreateDesktopCommandInput {
  const body = toBrowserKeyCommandBody(
    input
  ) satisfies BrowserKeyRevocationCommandBody;

  return {
    operationId: BROWSER_KEY_REVOCATION_OPERATION_ID,
    method: "POST",
    path: BROWSER_KEY_REVOCATION_PATH,
    body: body satisfies JsonValue,
  };
}

/**
 * Builds the internal Desktop command that asks an online target to prompt for
 * approval of a newly registered browser command-signing key.
 */
export function buildBrowserKeyApprovalRequestCommandInput(
  input: BrowserKeyCommandInput
): CreateDesktopCommandInput {
  const body = toBrowserKeyCommandBody(
    input
  ) satisfies BrowserKeyApprovalRequestCommandBody;

  return {
    operationId: BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID,
    method: "POST",
    path: BROWSER_KEY_APPROVAL_REQUEST_PATH,
    body: body satisfies JsonValue,
  };
}

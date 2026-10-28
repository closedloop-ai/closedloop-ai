import {
  DOC_SYNC_CALLBACK_MAX_BODY_BYTES,
  type DocSyncChangeCallback,
  docSyncChangeCallbackSchema,
} from "@repo/realtime-contract/doc-sync-internal";
import { readCappedRequestBytes } from "@/app/desktop/route-helpers";
import { env } from "@/env";
import {
  acceptedResponse,
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  payloadTooLargeResponse,
  serviceUnavailableResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";
import { parseCanonicalDocumentRoom } from "../canonical-room";
import { reportDocSyncCallerRefusal } from "./caller-refusal-telemetry";
import { docSyncChangeService } from "./change-service";
import { verifyDocSyncCaller } from "./verify-caller";

/**
 * PLN-2200 T-7.8: POST /doc-sync/changes. Not user-authenticated: the caller
 * is verified as the doc-sync task role through STS (Q-001 default A), and
 * the route answers 503 while `DOC_SYNC_CALLBACK_ROLE_ARN` is unset. A valid
 * callback for an existing document is handed to `receive` and answered 202.
 */
export function createDocSyncChangesHandler({
  verify = verifyDocSyncCaller,
}: {
  verify?: typeof verifyDocSyncCaller;
} = {}) {
  return async (request: Request): Promise<Response> => {
    const roleArn = env.DOC_SYNC_CALLBACK_ROLE_ARN;
    if (roleArn === undefined) {
      return serviceUnavailableResponse(NOT_CONFIGURED_MESSAGE);
    }
    const body = await readCappedRequestBytes(
      request,
      DOC_SYNC_CALLBACK_MAX_BODY_BYTES
    );
    if (!body.ok) {
      return payloadTooLargeResponse(PAYLOAD_TOO_LARGE_MESSAGE);
    }
    const caller = await verify(request, body.value, { roleArn });
    if (!caller.ok) {
      reportDocSyncCallerRefusal(caller.reason);
      return unauthorizedResponse();
    }
    const change = parseChange(body.value);
    if (change === undefined) {
      return badRequestResponse(INVALID_CHANGE_MESSAGE);
    }
    const room = parseCanonicalDocumentRoom(change.documentName);
    if (room === null) {
      return badRequestResponse(INVALID_DOCUMENT_NAME_MESSAGE);
    }
    try {
      const documentId = await docSyncChangeService.findDocumentId(room);
      if (documentId === null) {
        return notFoundResponse("Document");
      }
      await docSyncChangeService.receive({
        documentId,
        organizationId: room.organizationId,
        change,
      });
      return acceptedResponse({ callbackId: change.callbackId });
    } catch (error) {
      return errorResponse(RECEIVE_FAILED_MESSAGE, error);
    }
  };
}

function parseChange(rawBody: Buffer): DocSyncChangeCallback | undefined {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return;
  }
  return docSyncChangeCallbackSchema.safeParse(json).data;
}

const NOT_CONFIGURED_MESSAGE = "Document sync callbacks are not configured";
const PAYLOAD_TOO_LARGE_MESSAGE = "Change callback too large";
const INVALID_CHANGE_MESSAGE = "Invalid change callback";
const INVALID_DOCUMENT_NAME_MESSAGE = "Invalid document name";
const RECEIVE_FAILED_MESSAGE = "Unable to receive the document change";

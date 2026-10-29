import { Status } from "@repo/api/src/types/result";
import {
  badRequestResponse,
  forbiddenResponse,
  notFoundResponse,
} from "@/lib/route-utils";
import type { DocSyncTokenFailure } from "./service";

/** Maps a refused `POST /doc-sync/token` to its 400, 403 or 404 response. */
export function failureResponse(failure: DocSyncTokenFailure) {
  switch (failure.status) {
    case Status.BadRequest:
      return badRequestResponse(INVALID_ROOM_MESSAGE, { code: failure.code });
    case Status.Forbidden:
      return forbiddenResponse();
    case Status.NotFound:
      return notFoundResponse("Document", { code: failure.code });
    default:
      return assertNever(failure);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled document sync token failure: ${String(value)}`);
}

const INVALID_ROOM_MESSAGE = "Invalid room ID";

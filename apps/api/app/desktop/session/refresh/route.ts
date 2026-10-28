import "server-only";

import { z } from "zod";
import {
  desktopContractError,
  desktopContractSuccess,
} from "@/app/desktop/contract";
import {
  DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES,
  readBoundedJsonBody,
} from "@/app/desktop/route-helpers";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { desktopSessionService } from "../service";

const refreshRequestValidator = z
  .object({
    refreshToken: z.string().trim().min(1).max(512),
  })
  .strict();

async function handlePost(request: Request) {
  const { rawBody } = await readBoundedJsonBody(
    request,
    DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES
  );
  const parsedBody = refreshRequestValidator.safeParse(rawBody);
  if (!parsedBody.success) {
    return desktopContractError(400, "INVALID_DESKTOP_SESSION_REFRESH", false);
  }

  const outcome = await desktopSessionService
    .refresh({ refreshToken: parsedBody.data.refreshToken, request })
    .catch(() => null);

  if (outcome === null) {
    return desktopContractError(503, "DESKTOP_SESSION_REFRESH_FAILED", true);
  }

  if (!outcome.ok) {
    if (outcome.error === "pop_failed") {
      return desktopContractError(403, "DESKTOP_SESSION_POP_REQUIRED", false);
    }
    return desktopContractError(401, "DESKTOP_SESSION_REFRESH_INVALID", false);
  }

  return desktopContractSuccess(outcome.value);
}

export const POST = withRequestCompleted(handlePost);

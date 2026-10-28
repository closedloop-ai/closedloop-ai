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
import { desktopDeviceOnboardingService } from "../service";

const pollRequestValidator = z
  .object({
    deviceSessionId: z.string().trim().uuid(),
    deviceSessionSecret: z.string().trim().min(1).max(255),
  })
  .strict();

async function handlePost(request: Request) {
  const { rawBody } = await readBoundedJsonBody(
    request,
    DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES
  );
  const parsedBody = pollRequestValidator.safeParse(rawBody);
  if (!parsedBody.success) {
    return desktopContractError(400, "INVALID_DEVICE_SESSION_POLL", false);
  }

  const result = await desktopDeviceOnboardingService
    .poll(parsedBody.data)
    .catch(() => undefined);
  if (result === null) {
    return desktopContractError(401, "DEVICE_SESSION_INVALID", false);
  }
  if (result === undefined) {
    return desktopContractError(503, "DEVICE_SESSION_POLL_FAILED", true);
  }

  return desktopContractSuccess(result);
}

export const POST = withRequestCompleted(handlePost);

import "server-only";

import { z } from "zod";
import { uuidValidator } from "@/app/compute-targets/validators";
import {
  DesktopConnectStage,
  desktopConnectRejected,
  desktopContractSuccess,
} from "@/app/desktop/contract";
import {
  DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES,
  readBoundedJsonBody,
} from "@/app/desktop/route-helpers";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import {
  type DesktopSessionExchangeError,
  desktopSessionService,
} from "../service";

const exchangeRequestValidator = z
  .object({
    deviceSessionId: uuidValidator,
    deviceSessionSecret: z.string().trim().min(1).max(255),
  })
  .strict();

const EXCHANGE_ERROR_RESPONSES: Record<
  DesktopSessionExchangeError,
  { status: number; code: string }
> = {
  already_used: {
    status: 409,
    code: "DESKTOP_SESSION_ALREADY_USED",
  },
  invalid: {
    status: 401,
    code: "DESKTOP_SESSION_EXCHANGE_INVALID",
  },
  org_required: {
    status: 400,
    code: "DESKTOP_SESSION_ORG_REQUIRED",
  },
  pop_failed: {
    status: 403,
    code: "DESKTOP_SESSION_POP_REQUIRED",
  },
};

async function handlePost(request: Request) {
  const { rawBody } = await readBoundedJsonBody(
    request,
    DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES
  );
  const parsedBody = exchangeRequestValidator.safeParse(rawBody);
  if (!parsedBody.success) {
    return exchangeRejected(400, "INVALID_DESKTOP_SESSION_EXCHANGE", false);
  }

  const outcome = await desktopSessionService
    .exchange({
      deviceSessionId: parsedBody.data.deviceSessionId,
      deviceSessionSecret: parsedBody.data.deviceSessionSecret,
      request,
    })
    .catch(() => null);

  if (outcome === null) {
    return exchangeRejected(503, "DESKTOP_SESSION_EXCHANGE_FAILED", true);
  }

  if (!outcome.ok) {
    const errorResponse = EXCHANGE_ERROR_RESPONSES[outcome.error];
    return exchangeRejected(errorResponse.status, errorResponse.code, false);
  }

  return desktopContractSuccess(outcome.value);
}

function exchangeRejected<TCode extends string>(
  status: number,
  code: TCode,
  retryable: boolean
) {
  return desktopConnectRejected(status, code, retryable, {
    stage: DesktopConnectStage.SessionExchange,
  });
}

export const POST = withRequestCompleted(handlePost);

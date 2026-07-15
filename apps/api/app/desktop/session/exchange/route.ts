import "server-only";

import { z } from "zod";
import { uuidValidator } from "@/app/compute-targets/validators";
import {
  desktopContractError,
  desktopContractSuccess,
} from "@/app/desktop/contract";
import { desktopSessionService } from "../service";

const exchangeRequestValidator = z
  .object({
    deviceSessionId: uuidValidator,
    deviceSessionSecret: z.string().trim().min(1).max(255),
  })
  .strict();

export async function POST(request: Request) {
  const rawBody = await request.json().catch(() => null);
  const parsedBody = exchangeRequestValidator.safeParse(rawBody);
  if (!parsedBody.success) {
    return desktopContractError(400, "INVALID_DESKTOP_SESSION_EXCHANGE", false);
  }

  const outcome = await desktopSessionService
    .exchange({
      deviceSessionId: parsedBody.data.deviceSessionId,
      deviceSessionSecret: parsedBody.data.deviceSessionSecret,
      request,
    })
    .catch(() => null);

  if (outcome === null) {
    return desktopContractError(503, "DESKTOP_SESSION_EXCHANGE_FAILED", true);
  }

  if (!outcome.ok) {
    switch (outcome.error) {
      case "pop_failed":
        return desktopContractError(403, "DESKTOP_SESSION_POP_REQUIRED", false);
      case "already_used":
        return desktopContractError(409, "DESKTOP_SESSION_ALREADY_USED", false);
      case "org_required":
        return desktopContractError(400, "DESKTOP_SESSION_ORG_REQUIRED", false);
      default:
        return desktopContractError(
          401,
          "DESKTOP_SESSION_EXCHANGE_INVALID",
          false
        );
    }
  }

  return desktopContractSuccess(outcome.value);
}

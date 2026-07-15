import "server-only";

import { z } from "zod";
import {
  desktopContractError,
  desktopContractSuccess,
} from "@/app/desktop/contract";
import { desktopSessionService } from "../service";

const revokeRequestValidator = z
  .object({
    refreshToken: z.string().trim().min(1).max(512),
  })
  .strict();

export async function POST(request: Request) {
  const rawBody = await request.json().catch(() => null);
  const parsedBody = revokeRequestValidator.safeParse(rawBody);
  if (!parsedBody.success) {
    return desktopContractError(400, "INVALID_DESKTOP_SESSION_REVOKE", false);
  }

  const outcome = await desktopSessionService
    .revoke({ refreshToken: parsedBody.data.refreshToken, request })
    .catch(() => null);

  if (outcome === null) {
    return desktopContractError(503, "DESKTOP_SESSION_REVOKE_FAILED", true);
  }

  if (!outcome.ok) {
    return desktopContractError(403, "DESKTOP_SESSION_POP_REQUIRED", false);
  }

  return desktopContractSuccess({ status: "revoked" });
}

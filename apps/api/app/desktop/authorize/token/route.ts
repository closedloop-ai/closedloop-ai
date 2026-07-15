import "server-only";

import { log } from "@repo/observability/log";
import { z } from "zod";
import {
  desktopContractError,
  desktopContractSuccess,
} from "@/app/desktop/contract";
import { desktopAuthorizeService } from "../service";

/**
 * POST /desktop/authorize/token — redeem a one-time authorization code for
 * first-party desktop credentials (FEA-2409). Not Clerk-gated: authenticated by
 * the PKCE verifier + device proof-of-possession bound to the minted code.
 */
const tokenRequestValidator = z
  .object({
    code: z.string().trim().min(1).max(255),
    // RFC 7636 §4.1: the PKCE verifier is 43–128 unreserved chars.
    codeVerifier: z.string().trim().min(43).max(128),
    gatewayId: z.string().trim().min(1).max(255),
    redirectUri: z.string().trim().min(1).max(2048),
  })
  .strict();

export async function POST(request: Request) {
  const rawBody = await request.json().catch(() => null);
  const parsedBody = tokenRequestValidator.safeParse(rawBody);
  if (!parsedBody.success) {
    return desktopContractError(400, "INVALID_DESKTOP_AUTHORIZE_TOKEN", false);
  }

  const outcome = await desktopAuthorizeService
    .redeem({
      code: parsedBody.data.code,
      codeVerifier: parsedBody.data.codeVerifier,
      gatewayId: parsedBody.data.gatewayId,
      redirectUri: parsedBody.data.redirectUri,
      request,
    })
    .catch((error: unknown) => {
      // redeem() only rejects on an unexpected server-side fault — e.g. a missing
      // DESKTOP_SESSION_JWT_SECRET at credential issuance, or a DB error. A
      // rejected/expired code or PoP failure comes back as a typed `!ok` result,
      // not a throw. This route otherwise collapses the fault into an opaque 503,
      // so log the reason (message only — never token / PKCE verifier / PoP
      // material) to make the failure diagnosable from server logs.
      log.error("desktop_authorize_token_redeem_faulted", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

  if (outcome === null) {
    return desktopContractError(503, "DESKTOP_AUTHORIZE_TOKEN_FAILED", true);
  }
  if (!outcome.ok) {
    switch (outcome.error) {
      case "pop_failed":
        return desktopContractError(403, "DESKTOP_SESSION_POP_REQUIRED", false);
      default:
        return desktopContractError(
          401,
          "DESKTOP_AUTHORIZE_TOKEN_INVALID",
          false
        );
    }
  }

  return desktopContractSuccess(outcome.value);
}

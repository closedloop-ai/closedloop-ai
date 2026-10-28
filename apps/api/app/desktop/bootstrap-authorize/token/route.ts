import "server-only";

import { DesktopBootstrapErrorCode } from "@repo/api/src/types/desktop-bootstrap";
import { log } from "@repo/observability/log";
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
import { desktopBootstrapSchemaReadinessService } from "../schema-readiness-service";
import { desktopBootstrapAuthorizeService } from "../service";

const requestValidator = z
  .object({
    code: z.string().trim().min(1).max(255),
    codeVerifier: z.string().trim().min(43).max(128),
    gatewayId: z.string().trim().min(1).max(255),
    redirectUri: z.string().trim().min(1).max(2048),
  })
  .strict();

export const POST = createDesktopBootstrapTokenHandler();

async function handlePost(request: Request) {
  const { rawBody } = await readBoundedJsonBody(
    request,
    DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES
  );
  const parsed = requestValidator.safeParse(rawBody);
  if (!parsed.success) {
    return desktopContractError(
      400,
      DesktopBootstrapErrorCode.TokenInvalidBody,
      false
    );
  }
  if (!(await desktopBootstrapSchemaReadinessService.isReady())) {
    return desktopContractError(
      503,
      DesktopBootstrapErrorCode.TokenFailed,
      true
    );
  }
  const result = await desktopBootstrapAuthorizeService
    .redeem({ ...parsed.data, request })
    .catch((error: unknown) => {
      log.error("desktop_bootstrap_token_redeem_faulted", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  if (!result) {
    return desktopContractError(
      503,
      DesktopBootstrapErrorCode.TokenFailed,
      true
    );
  }
  if (!result.ok) {
    return result.error === "pop_failed"
      ? desktopContractError(
          403,
          DesktopBootstrapErrorCode.ProofOfPossessionRequired,
          false
        )
      : desktopContractError(
          401,
          DesktopBootstrapErrorCode.TokenInvalid,
          false
        );
  }
  return desktopContractSuccess(result.value);
}

function createDesktopBootstrapTokenHandler() {
  return withRequestCompleted(handlePost);
}

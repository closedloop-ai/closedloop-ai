import "server-only";

import { z } from "zod";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { repoBranchSchema } from "@/lib/repo-validator-helpers";
import { personRequestShape } from "../person-request";
import { vibeEnvironmentHandler } from "../respond";
import { mintVibeEnvironmentDesktopSession } from "../service";

/**
 * ISS-12056 (decision 5): a Desktop session in the branch's vibe environment
 * for the person's own user, from the claim their laptop's profile made
 * (`vibe:profile auth-claim`): the refresh token's SHA-256, the Ed25519 public
 * key, and the gateway id. None of them can refresh a session without the
 * token and private key, which never leave the laptop. A repeat claim answers
 * with the session it already has.
 */

export const maxDuration = 30;

const SHA256_HEX = /^[0-9a-f]{64}$/;

const desktopSessionRequestValidator = z.object({
  branch: repoBranchSchema,
  ...personRequestShape,
  desktopAuth: z.object({
    refreshTokenHash: z.string().regex(SHA256_HEX),
    publicKeySpki: z.base64().min(1).max(200),
    gatewayId: z.uuid(),
  }),
});

export const POST = withRequestCompleted(
  vibeEnvironmentHandler(
    {
      validator: desktopSessionRequestValidator,
      unexpectedFailureMessage:
        "Failed to create a Desktop session for a vibe environment; see the api-stage logs for this request",
    },
    (body) =>
      mintVibeEnvironmentDesktopSession(body.branch, {
        personEmail: body.personEmail,
        desktopAuth: body.desktopAuth,
        ...(body.clerkOrgId === undefined
          ? {}
          : { clerkOrgId: body.clerkOrgId }),
      })
  )
);
